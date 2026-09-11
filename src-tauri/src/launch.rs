use crate::error::{NativeError, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitHubKind {
    Pr,
    Issue,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GitHubIdentity {
    pub source: String,
    pub owner: String,
    pub repo: String,
    pub kind: GitHubKind,
    pub number: u64,
}

#[derive(Debug, Serialize)]
pub struct LaunchResult {
    pub status: &'static str,
    pub url: String,
}

impl GitHubIdentity {
    fn validate(&self) -> Result<()> {
        let owner = self.owner.as_bytes();
        if self.source != "github"
            || owner.is_empty()
            || owner.len() > 39
            || !owner.first().is_some_and(u8::is_ascii_alphanumeric)
            || !owner.last().is_some_and(u8::is_ascii_alphanumeric)
            || !owner
                .iter()
                .all(|c| c.is_ascii_alphanumeric() || *c == b'-')
            || self.owner.contains("--")
            || matches!(
                self.owner.to_ascii_lowercase().as_str(),
                "sample" | "fixture" | "synthetic"
            )
            || self.repo.is_empty()
            || self.repo.len() > 100
            || matches!(self.repo.as_str(), "." | "..")
            || !self
                .repo
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            || self.number == 0
            || self.number > 9_007_199_254_740_991
        {
            return Err(NativeError::new("invalid-destination", "Use a real github.com issue or pull request. Synthetic or malformed destinations cannot be opened."));
        }
        Ok(())
    }

    pub fn url(&self, copilot: bool) -> Result<String> {
        self.validate()?;
        let repository = format!("{}/{}", self.owner, self.repo);
        if copilot {
            match self.kind {
                GitHubKind::Pr => {
                    let encoded: String =
                        url::form_urlencoded::byte_serialize(repository.as_bytes()).collect();
                    Ok(format!("ghapp://session/new?repo={encoded}&pr={}&mode=interactive&prompt=Review%20this%20PR", self.number))
                }
                GitHubKind::Issue => Ok(format!(
                    "ghapp://github.com/{repository}/issues/{}",
                    self.number
                )),
            }
        } else {
            let kind = match self.kind {
                GitHubKind::Pr => "pull",
                GitHubKind::Issue => "issues",
            };
            Ok(format!(
                "https://github.com/{repository}/{kind}/{}",
                self.number
            ))
        }
    }
}

pub fn dispatch(identity: GitHubIdentity, copilot: bool) -> Result<LaunchResult> {
    let url = identity.url(copilot)?;
    #[cfg(target_os = "macos")]
    {
        // Fixed executable and validated, generated URL; no shell, renderer arguments, or output logging.
        let status = std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        if !status.success() {
            return Err(NativeError::new("launch-failed", "macOS could not open this destination. Check that Copilot App or a browser is installed. Your work is unchanged."));
        }
        Ok(LaunchResult {
            status: "dispatch-requested",
            url,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err(NativeError::new(
            "unsupported-platform",
            "Native launching is currently supported only on macOS.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> GitHubIdentity {
        GitHubIdentity {
            source: "github".into(),
            owner: "octo-org".into(),
            repo: "hello.world".into(),
            kind: GitHubKind::Pr,
            number: 123,
        }
    }

    #[test]
    fn exact_pr_issue_and_browser_urls() {
        let mut input = identity();
        assert_eq!(input.url(true).unwrap(), "ghapp://session/new?repo=octo-org%2Fhello.world&pr=123&mode=interactive&prompt=Review%20this%20PR");
        assert_eq!(
            input.url(false).unwrap(),
            "https://github.com/octo-org/hello.world/pull/123"
        );
        input.kind = GitHubKind::Issue;
        assert_eq!(
            input.url(true).unwrap(),
            "ghapp://github.com/octo-org/hello.world/issues/123"
        );
        assert_eq!(
            input.url(false).unwrap(),
            "https://github.com/octo-org/hello.world/issues/123"
        );
    }

    #[test]
    fn rejects_synthetic_injected_and_invalid_identities() {
        for owner in [
            "", "sample", "SAMPLE", "fixture", "a/b", "a?x=1", "a--b", "-org", "org-", "gïthub",
            "host.com",
        ] {
            let mut input = identity();
            input.owner = owner.into();
            assert!(input.url(true).is_err(), "{owner}");
        }
        for repo in [
            "",
            ".",
            "..",
            "repo#fragment",
            "repo&prompt=secret",
            "/tmp/file",
            "repo\narg",
            "repo%2Fother",
        ] {
            let mut input = identity();
            input.repo = repo.into();
            assert!(input.url(true).is_err(), "{repo}");
        }
        let mut input = identity();
        input.source = "fixture".into();
        assert!(input.url(false).is_err());
        input = identity();
        input.number = 0;
        assert!(input.url(true).is_err());
        input.number = u64::MAX;
        assert!(input.url(true).is_err());
        assert!(serde_json::from_str::<GitHubIdentity>(
            r#"{"source":"github","owner":"a","repo":"b","number":-1,"kind":"pr"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<GitHubIdentity>(r#"{"source":"github","owner":"a","repo":"b","number":1,"kind":"pr","prompt":"private"}"#).is_err());
    }
}
