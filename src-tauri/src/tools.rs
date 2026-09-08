use serde::Serialize;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time::timeout,
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authenticated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn resolve_tool(name: &str, configured: &str) -> Result<PathBuf, String> {
    if !["gh", "copilot"].contains(&name) {
        return Err("Unsupported executable.".into());
    }
    if !configured.trim().is_empty() {
        let path = PathBuf::from(configured.trim());
        return validate_executable(&path).map(|_| path);
    }
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .filter(|p| p.is_absolute())
                .map(|p| p.join(name))
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for relative in [".local/bin", ".npm-global/bin", ".volta/bin", "bin"] {
            candidates.push(home.join(relative).join(name));
        }
        if name == "gh" {
            candidates.push(home.join("Library/Caches/copilot-desktop-gh-2.98.0/gh"));
        }
    }
    for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        candidates.push(Path::new(directory).join(name));
    }
    candidates.into_iter().find(|p| validate_executable(p).is_ok()).ok_or_else(|| format!("Cannot find {name}. Set its absolute executable path in Connections. Finder does not inherit your terminal PATH."))
}

pub fn validate_executable(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .as_os_str()
            .to_string_lossy()
            .chars()
            .any(char::is_control)
    {
        return Err(
            "Use an absolute executable path without control characters, not a shell command."
                .into(),
        );
    }
    let metadata = std::fs::metadata(path).map_err(|_| {
        format!(
            "Executable not found at {}. Check the saved path.",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err("The executable path must point to a file.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("The selected file is not executable.".into());
        }
    }
    Ok(())
}

pub fn child_path(executable: &Path) -> OsString {
    let mut paths = Vec::new();
    if let Some(parent) = executable.parent() {
        paths.push(parent.to_path_buf());
    }
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path).filter(|path| path.is_absolute()));
    }
    paths.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        paths.push(home.join(".local/bin"));
        paths.push(home.join("Library/Caches/copilot-desktop-gh-2.98.0"));
    }
    std::env::join_paths(paths)
        .unwrap_or_else(|_| OsString::from("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"))
}

async fn limited_read<R: AsyncRead + Unpin>(reader: R, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "Cannot read executable output.")?;
    if bytes.len() > limit {
        return Err("Executable output exceeded its safe size limit.".into());
    }
    Ok(bytes)
}

pub async fn run_gh(path: &Path, args: &[String]) -> Result<Vec<u8>, String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .env("PATH", child_path(path))
        .env("GH_HOST", "github.com")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start gh. Check its configured path and executable permissions.")?;
    let stdout = child.stdout.take().ok_or("Missing gh output stream.")?;
    let stderr = child.stderr.take().ok_or("Missing gh error stream.")?;
    let operation = async {
        let (output, _, status) = tokio::try_join!(
            limited_read(stdout, 4 * 1024 * 1024),
            limited_read(stderr, 64 * 1024),
            async {
                child
                    .wait()
                    .await
                    .map_err(|_| "Cannot wait for gh.".to_string())
            }
        )?;
        if !status.success() {
            // CLI stderr can contain credentials or server response bodies. Never forward it.
            return Err(format!(
                "gh failed (exit {}). Check `gh auth status --hostname github.com`, network access, and repository permissions in your terminal.",
                status
                    .code()
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "terminated".into())
            ));
        }
        Ok(output)
    };
    timeout(Duration::from_secs(25), operation)
        .await
        .map_err(|_| {
            "GitHub request timed out after 25 seconds. The previous snapshot is unchanged."
                .to_string()
        })?
}

pub async fn github_login(path: &Path) -> Result<String, String> {
    let args = [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "user",
        "--jq",
        ".login",
    ]
    .map(String::from);
    let output = run_gh(path, &args).await?;
    let login = std::str::from_utf8(&output)
        .map_err(|_| "GitHub returned an invalid login.")?
        .trim();
    if login.is_empty()
        || login.len() > 100
        || !login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("GitHub returned an invalid login.".into());
    }
    Ok(login.into())
}

pub fn canonical_github_url(input: &str) -> Result<String, String> {
    let fail = || {
        "Only canonical https://github.com/owner/repo/pull/123 or /issues/123 links are allowed."
            .to_string()
    };
    let parsed = url::Url::parse(input).map_err(|_| fail())?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !input.starts_with("https://github.com/")
        || input.contains(['%', '\\'])
    {
        return Err(fail());
    }
    let parts: Vec<_> = parsed.path().trim_start_matches('/').split('/').collect();
    if parts.len() != 4
        || !valid_repo_part(parts[0])
        || !valid_repo_part(parts[1])
        || !["pull", "issues"].contains(&parts[2])
        || parts[3].starts_with('0')
        || !parts[3].bytes().all(|b| b.is_ascii_digit())
        || parts[3].parse::<u64>().is_err()
    {
        return Err(fail());
    }
    let canonical = format!(
        "https://github.com/{}/{}/{}/{}",
        parts[0], parts[1], parts[2], parts[3]
    );
    if canonical != input {
        return Err(fail());
    }
    Ok(canonical)
}

fn valid_repo_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && !value.starts_with(['-', '.'])
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

pub fn valid_repository(repository: &str) -> bool {
    let parts: Vec<_> = repository.split('/').collect();
    parts.len() == 2 && parts.iter().all(|part| valid_repo_part(part))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restrict_urls_and_cli_repositories() {
        assert!(canonical_github_url("https://github.com/acme/work/pull/42").is_ok());
        for url in [
            "http://github.com/a/b/pull/1",
            "https://github.com.evil/a/b/pull/1",
            "https://u@github.com/a/b/pull/1",
            "https://github.com/a/b/pull/1?x=1",
            "https://github.com/a/b/pull/01",
            "https://github.com/a/../b/pull/1",
            "https://github.com/a/b/pull/1#x",
            "https://github.com/a/b/pull/1/",
            "https://github.com/a/b/%70ull/1",
            "https://github.com:443/a/b/pull/1",
        ] {
            assert!(canonical_github_url(url).is_err(), "{url}");
        }
        for repo in ["--repo=x", "a/b/c", "a/../b", "a/b; rm", "/b", "a/-b"] {
            assert!(!valid_repository(repo));
        }
        assert!(valid_repository("integrations/terraform-provider-github"));
        assert!(validate_executable(Path::new("gh")).is_err());
    }
}
