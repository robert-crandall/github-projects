use crate::{
    conversation::{ConversationKind, ConversationReference},
    error::{NativeError, Result},
};
use serde::{Deserialize, Serialize};

pub const NOT_INSPECTED: &str =
    "No source-code lines were inspected. No code review or approval was completed.";
pub const PARTIAL: &str = "Partial code inspection only. This is not an approval to merge.";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Job {
    ImplementationAssessment,
    PrReview,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Agent {
    pub id: String,
    pub instructions: String,
    pub model: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub task_id: String,
    pub source: ConversationReference,
    pub job: Job,
    pub agent: Agent,
}

pub fn bounded(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.encode_utf16().count())
}
pub fn trimmed(s: &str) -> &str {
    s.trim_matches(|c| matches!(c,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' |
        '\u{3000}' | '\u{feff}'))
}
fn prose(s: &str, max: usize) -> bool {
    bounded(trimmed(s), 1, max)
}
fn hash(s: &str, size: usize) -> bool {
    s.len() == size
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn repository(repo: &str) -> bool {
    ConversationReference { repo: repo.into(), number: 1, kind: ConversationKind::Issue }
        .validate().is_ok()
}
fn path(s: &str) -> bool {
    bounded(s, 1, 1024)
        && !s.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}' || "\\%?#:".contains(c))
        && s.split('/').all(|part| !matches!(part, "" | "." | ".."))
}
pub(crate) fn result_timestamp(s: &str) -> Result<()> {
    let valid = || -> Option<()> {
        let (date, time) = s.split_once('T')?;
        if date.len() != 10 || !date.bytes().enumerate().all(|(i, c)|
            if i == 4 || i == 7 { c == b'-' } else { c.is_ascii_digit() }) {
            return None;
        }
        chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
        let time = time.strip_suffix('Z')?;
        let (clock, fraction) = time.split_once('.').map_or((time, None), |(t, f)| (t, Some(f)));
        if !matches!(clock.len(), 5 | 8)
            || !clock.bytes().enumerate().all(|(i, c)|
                if i == 2 || i == 5 { c == b':' } else { c.is_ascii_digit() })
            || &clock[..2] > "23" || &clock[3..5] > "59"
            || (clock.len() == 8 && &clock[6..] > "59")
            || fraction.is_some_and(|f| clock.len() != 8 || f.is_empty() || !f.bytes().all(|c| c.is_ascii_digit()))
        {
            return None;
        }
        Some(())
    };
    valid().ok_or_else(NativeError::invalid)
}
fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error> {
    Option::deserialize(deserializer)
}
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

impl Input {
    pub fn validate(&self) -> Result<()> {
        self.source.validate()?;
        if !bounded(&self.task_id, 1, 500)
            || !self
                .task_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b":_./-".contains(&b))
            || !bounded(&self.agent.id, 1, 100)
            || !bounded(&self.agent.instructions, 0, 16000)
            || !bounded(&self.agent.model, 0, 100)
            || (self.job == Job::PrReview) != (self.source.kind == ConversationKind::Pr)
        {
            return Err(NativeError::invalid());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Head,
    Base,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Citation {
    Source {
        quote: String,
    },
    Code {
        #[serde(rename = "readId")]
        read_id: String,
        side: Side,
        path: String,
        #[serde(rename = "startLine")]
        start_line: u64,
        #[serde(rename = "endLine")]
        end_line: u64,
        quote: String,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Finding {
    title: String,
    severity: Severity,
    rationale: String,
    evidence: Vec<Citation>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    location: Option<Citation>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NextStep {
    text: String,
    evidence: Vec<Citation>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ConclusionStatus {
    NotInspected,
    PartialNoApproval,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Conclusion {
    pub status: ConclusionStatus,
    pub summary: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "job", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Answer {
    ImplementationAssessment {
        summary: String,
        uncertainty: String,
        findings: Vec<Finding>,
        #[serde(rename = "nextStep")]
        next_step: NextStep,
    },
    PrReview {
        findings: Vec<Finding>,
        conclusion: Conclusion,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Revision {
    repo: String,
    sha: String,
    tree: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub reference: ConversationReference,
    url: String,
    title: String,
    body: String,
    updated_at: String,
    state: String,
    fingerprint: String,
    observed_at: String,
    head: Revision,
    #[serde(deserialize_with = "nullable")]
    base: Option<Revision>,
    #[serde(deserialize_with = "nullable")]
    base_tip: Option<String>,
    #[serde(deserialize_with = "nullable")]
    default_branch: Option<String>,
    #[serde(deserialize_with = "nullable")]
    draft: Option<bool>,
    #[serde(deserialize_with = "nullable")]
    merged: Option<bool>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ModelSelection {
    Explicit,
    SdkDefault,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    agent_id: String,
    instructions: String,
    model_requested: String,
    model_selection: ModelSelection,
    fingerprint: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Read {
    id: String,
    side: Side,
    repo: String,
    revision: String,
    blob: String,
    path: String,
    start_line: u64,
    end_line: u64,
    total_lines: u64,
    text: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileCoverage {
    #[serde(deserialize_with = "nullable")]
    expected: Option<u64>,
    compared: u64,
    retained: u64,
    omitted: u64,
    incomplete_patches: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ChangedCoverage {
    Complete,
    Partial,
    NotApplicable,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Coverage {
    status: String,
    changes: ChangedCoverage,
    known_changed_lines: u64,
    reviewed_changed_lines: u64,
    files: FileCoverage,
    warnings: Vec<String>,
    requests: u64,
    read_bytes: u64,
    context_bytes: u64,
    tool_calls: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Change {
    filename: String,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    previous_filename: Option<String>,
    status: String,
    additions: u64,
    deletions: u64,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    patch: Option<String>,
    #[serde(rename = "patchComplete")]
    patch_complete: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeResult {
    format: String,
    task_id: String,
    pub answer: Answer,
    source: Source,
    verified_at: String,
    config: Config,
    coverage: Coverage,
    evidence: Vec<Read>,
    changes: Vec<Change>,
}
impl Revision {
    fn valid(&self) -> bool {
        repository(&self.repo) && hash(&self.sha, 40) && hash(&self.tree, 40)
    }
}
impl Citation {
    fn valid(&self) -> bool {
        match self {
            Self::Source { quote } => bounded(quote, 1, 4000),
            Self::Code { read_id, path: file, start_line, end_line, quote, .. } => {
                read_id.strip_prefix("read-").is_some_and(|id|
                    matches!(id.len(), 1 | 2) && id.as_bytes()[0] != b'0'
                        && id.bytes().all(|c| c.is_ascii_digit()))
                    && path(file)
                    && (1..=MAX_SAFE_INTEGER).contains(start_line)
                    && (1..=MAX_SAFE_INTEGER).contains(end_line)
                    && bounded(quote, 1, 4000)
            }
        }
    }
}
impl CodeResult {
    pub fn not_inspected(&self) -> bool {
        matches!(&self.answer, Answer::PrReview { conclusion, .. } if conclusion.status == ConclusionStatus::NotInspected)
    }
    pub fn validate(&self, input: &Input) -> Result<()> {
        let reject = || NativeError::invalid();
        let config = &self.config;
        if self.format != "code-review-v1"
            || self.task_id != input.task_id
            || self.source.reference != input.source
            || config.agent_id != input.agent.id
            || config.instructions != input.agent.instructions
            || config.model_requested != input.agent.model
            || !hash(&config.fingerprint, 64)
            || !hash(&self.source.fingerprint, 64)
            || !self.source.head.valid()
            || self.source.base.as_ref().is_some_and(|base| !base.valid())
            || self.source.base_tip.as_ref().is_some_and(|tip| !hash(tip, 40))
            || self.coverage.status != "partial"
            || self.coverage.requests > 40
            || self.coverage.tool_calls > 24
            || self.coverage.context_bytes > 180000
            || self.coverage.read_bytes > 8388608
            || self.coverage.files.compared > 300
            || self.coverage.files.retained > 100
            || self.coverage.known_changed_lines > MAX_SAFE_INTEGER
            || self.coverage.reviewed_changed_lines > MAX_SAFE_INTEGER
            || self.coverage.files.expected.is_some_and(|n| n > MAX_SAFE_INTEGER)
            || self.coverage.files.omitted > MAX_SAFE_INTEGER
            || self.coverage.files.incomplete_patches > MAX_SAFE_INTEGER
            || self.changes.len() > 100
            || self.evidence.len() > 24
            || self.changes.iter().any(|change|
                change.additions > MAX_SAFE_INTEGER || change.deletions > MAX_SAFE_INTEGER)
            || self.evidence.iter().any(|read|
                !repository(&read.repo) || !hash(&read.revision, 40) || !hash(&read.blob, 40)
                    || !path(&read.path) || !(1..=MAX_SAFE_INTEGER).contains(&read.start_line)
                    || read.end_line > MAX_SAFE_INTEGER || read.total_lines > MAX_SAFE_INTEGER)
            || (config.model_selection == ModelSelection::SdkDefault)
                != input.agent.model.is_empty()
        {
            return Err(reject());
        }
        for time in [
            &self.source.updated_at,
            &self.source.observed_at,
            &self.verified_at,
        ] {
            result_timestamp(time)?;
        }
        let validate_citation = |citation: &Citation| -> bool {
            if !citation.valid() {
                return false;
            }
            match citation {
                Citation::Source { quote } => {
                    !quote.is_empty()
                        && (self.source.title.contains(quote) || self.source.body.contains(quote))
                }
                Citation::Code {
                    read_id,
                    side,
                    path,
                    start_line,
                    end_line,
                    quote,
                } => self.evidence.iter().any(|read| {
                    &read.id == read_id
                        && &read.side == side
                        && &read.path == path
                        && *start_line >= read.start_line
                        && end_line >= start_line
                        && end_line - start_line <= 4
                        && *end_line <= read.end_line
                        && read
                            .text
                            .split('\n')
                            .skip((start_line - read.start_line) as usize)
                            .take((end_line - start_line + 1) as usize)
                            .collect::<Vec<_>>()
                            .join("\n")
                            == *quote
                }),
            }
        };
        let findings = match &self.answer {
            Answer::ImplementationAssessment {
                summary,
                uncertainty,
                findings,
                next_step,
            } => {
                if input.job != Job::ImplementationAssessment
                    || !prose(summary, 2000)
                    || !prose(uncertainty, 2000)
                    || !prose(&next_step.text, 2000)
                    || !(1..=8).contains(&next_step.evidence.len())
                    || self.evidence.is_empty()
                    || !next_step
                        .evidence
                        .iter()
                        .any(|c| matches!(c, Citation::Code { .. }))
                    || !next_step.evidence.iter().all(&validate_citation)
                {
                    return Err(reject());
                }
                findings
            }
            Answer::PrReview {
                findings,
                conclusion,
            } => {
                if input.job != Job::PrReview
                    || self.not_inspected() != self.evidence.is_empty()
                    || conclusion.summary
                        != if self.not_inspected() {
                            NOT_INSPECTED
                        } else {
                            PARTIAL
                        }
                {
                    return Err(reject());
                }
                findings
            }
        };
        if findings.len() > 20
            || findings.iter().any(|f| {
                !prose(&f.title, 240)
                    || !prose(&f.rationale, 2000)
                    || f.evidence.is_empty()
                    || f.evidence.len() > 8
                    || !f.evidence.iter().all(&validate_citation)
                    || if input.job == Job::PrReview {
                        !f.location.as_ref().is_some_and(|c| {
                            matches!(c, Citation::Code { .. }) && validate_citation(c)
                        })
                    } else {
                        f.location.is_some()
                    }
            })
        {
            return Err(reject());
        }
        Ok(())
    }
}
