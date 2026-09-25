use crate::{
    conversation::{ConversationKind, ConversationReference},
    error::{NativeError, Result},
    model::timestamp,
};
use serde::{Deserialize, Serialize};

pub const NOT_INSPECTED: &str =
    "No source-code lines were inspected. No code review or approval was completed.";
pub const PARTIAL: &str = "Partial code inspection only. This is not an approval to merge.";

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
    (min..=max).contains(&s.chars().count())
}
fn hash(s: &str, size: usize) -> bool {
    s.len() == size
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
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
    #[serde(skip_serializing_if = "Option::is_none")]
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
    base: Option<Revision>,
    base_tip: Option<String>,
    default_branch: Option<String>,
    draft: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_filename: Option<String>,
    status: String,
    additions: u64,
    deletions: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
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
            || !hash(&self.source.head.sha, 40)
            || !hash(&self.source.head.tree, 40)
            || self.coverage.status != "partial"
            || self.coverage.requests > 40
            || self.coverage.tool_calls > 24
            || self.coverage.context_bytes > 180000
            || self.coverage.read_bytes > 8388608
            || self.coverage.files.compared > 300
            || self.coverage.files.retained > 100
            || self.changes.len() > 100
            || self.evidence.len() > 24
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
            timestamp(time)?;
        }
        let validate_citation = |citation: &Citation| -> bool {
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
                findings,
                next_step,
                ..
            } => {
                if input.job != Job::ImplementationAssessment
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
                f.evidence.is_empty()
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
