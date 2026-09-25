use crate::{
    conversation::{ConversationKind, ConversationReference},
    error::{NativeError, Result},
};
use serde::{Deserialize, Serialize};

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
