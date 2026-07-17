use std::collections::HashMap;
use std::io::{BufRead, Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_FRAME_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Aborting,
    Succeeded,
    Failed,
    Aborted,
    Interrupted,
}

impl JobState {
    fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Queued, Self::Running)
                | (Self::Queued, Self::Aborted)
                | (Self::Running, Self::Aborting)
                | (Self::Running, Self::Succeeded)
                | (Self::Running, Self::Failed)
                | (Self::Running, Self::Interrupted)
                | (Self::Aborting, Self::Aborted)
                | (Self::Aborting, Self::Failed)
                | (Self::Aborting, Self::Interrupted)
                | (Self::Interrupted, Self::Queued)
        )
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Aborted)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    owner: String,
    generation: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    sequence: u64,
    event_id: String,
    payload: Value,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    job_id: String,
    state: JobState,
    lease: Option<Lease>,
    last_sequence: u64,
}

#[derive(Debug)]
struct Job {
    state: JobState,
    lease: Option<Lease>,
    next_lease_generation: u64,
    events: Vec<JobEvent>,
    event_sequences: HashMap<String, usize>,
}

#[derive(Default, Debug)]
pub struct JobAuthority {
    jobs: HashMap<String, Job>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum AuthorityError {
    InvalidIdentifier,
    AlreadyExists,
    NotFound,
    LeaseHeld,
    StaleLease,
    InvalidTransition,
    TerminalJob,
    EventConflict,
}

impl JobAuthority {
    pub fn create(&mut self, job_id: &str) -> Result<JobSnapshot, AuthorityError> {
        validate_id(job_id)?;
        if self.jobs.contains_key(job_id) {
            return Err(AuthorityError::AlreadyExists);
        }
        self.jobs.insert(
            job_id.to_owned(),
            Job {
                state: JobState::Queued,
                lease: None,
                next_lease_generation: 1,
                events: Vec::new(),
                event_sequences: HashMap::new(),
            },
        );
        self.snapshot(job_id)
    }

    pub fn acquire(&mut self, job_id: &str, owner: &str) -> Result<Lease, AuthorityError> {
        validate_id(owner)?;
        let job = self.jobs.get_mut(job_id).ok_or(AuthorityError::NotFound)?;
        if job.state.is_terminal() {
            return Err(AuthorityError::TerminalJob);
        }
        if job.lease.is_some() {
            return Err(AuthorityError::LeaseHeld);
        }
        let lease = Lease {
            owner: owner.to_owned(),
            generation: job.next_lease_generation,
        };
        job.next_lease_generation += 1;
        job.lease = Some(lease.clone());
        Ok(lease)
    }

    pub fn transition(
        &mut self,
        job_id: &str,
        lease: &Lease,
        next: JobState,
    ) -> Result<JobSnapshot, AuthorityError> {
        let job = self.jobs.get_mut(job_id).ok_or(AuthorityError::NotFound)?;
        if job.lease.as_ref() != Some(lease) {
            return Err(AuthorityError::StaleLease);
        }
        if !job.state.can_transition_to(next) {
            return Err(AuthorityError::InvalidTransition);
        }
        job.state = next;
        if next.is_terminal() {
            job.lease = None;
        }
        self.snapshot(job_id)
    }

    pub fn append_event(
        &mut self,
        job_id: &str,
        lease: &Lease,
        event_id: &str,
        payload: Value,
    ) -> Result<JobEvent, AuthorityError> {
        validate_id(event_id)?;
        let job = self.jobs.get_mut(job_id).ok_or(AuthorityError::NotFound)?;
        if job.lease.as_ref() != Some(lease) {
            return Err(AuthorityError::StaleLease);
        }
        if let Some(index) = job.event_sequences.get(event_id).copied() {
            let existing = &job.events[index];
            return if existing.payload == payload {
                Ok(existing.clone())
            } else {
                Err(AuthorityError::EventConflict)
            };
        }
        let event = JobEvent {
            sequence: job.events.len() as u64 + 1,
            event_id: event_id.to_owned(),
            payload,
        };
        job.event_sequences
            .insert(event_id.to_owned(), job.events.len());
        job.events.push(event.clone());
        Ok(event)
    }

    pub fn replay(&self, job_id: &str, after: u64) -> Result<Vec<JobEvent>, AuthorityError> {
        let job = self.jobs.get(job_id).ok_or(AuthorityError::NotFound)?;
        Ok(job
            .events
            .iter()
            .filter(|event| event.sequence > after)
            .cloned()
            .collect())
    }

    pub fn reconcile(&mut self) -> Vec<JobSnapshot> {
        let ids: Vec<String> = self.jobs.keys().cloned().collect();
        let mut changed = Vec::new();
        for job_id in ids {
            let job = self.jobs.get_mut(&job_id).expect("collected job exists");
            if matches!(job.state, JobState::Running | JobState::Aborting) {
                job.state = JobState::Interrupted;
                job.lease = None;
                changed.push(self.snapshot(&job_id).expect("collected job exists"));
            }
        }
        changed.sort_by(|left, right| left.job_id.cmp(&right.job_id));
        changed
    }

    pub fn snapshot(&self, job_id: &str) -> Result<JobSnapshot, AuthorityError> {
        let job = self.jobs.get(job_id).ok_or(AuthorityError::NotFound)?;
        Ok(JobSnapshot {
            job_id: job_id.to_owned(),
            state: job.state,
            lease: job.lease.clone(),
            last_sequence: job.events.len() as u64,
        })
    }
}

fn validate_id(value: &str) -> Result<(), AuthorityError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        Err(AuthorityError::InvalidIdentifier)
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol_version: u8,
    id: String,
    method: String,
    job_id: Option<String>,
    owner: Option<String>,
    lease: Option<Lease>,
    state: Option<JobState>,
    event_id: Option<String>,
    payload: Option<Value>,
    after: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<'a> {
    protocol_version: u8,
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

pub fn run<R: BufRead, W: Write>(mut input: R, mut output: W) -> bool {
    let mut authority = JobAuthority::default();
    let mut frame = Vec::new();
    loop {
        frame.clear();
        let read = match Read::by_ref(&mut input)
            .take(MAX_FRAME_BYTES as u64 + 1)
            .read_until(b'\n', &mut frame)
        {
            Ok(read) => read,
            Err(_) => return false,
        };
        if read == 0 {
            return true;
        }
        if frame.len() > MAX_FRAME_BYTES || !frame.ends_with(b"\n") {
            return false;
        }
        frame.pop();
        let request: Request = match serde_json::from_slice(&frame) {
            Ok(request) => request,
            Err(_) => return false,
        };
        if request.protocol_version != 1 || validate_id(&request.id).is_err() {
            return false;
        }

        let result = dispatch(&mut authority, &request);
        let response = match result {
            Ok(value) => Response {
                protocol_version: 1,
                id: &request.id,
                ok: true,
                result: Some(value),
                error: None,
            },
            Err(error) => Response {
                protocol_version: 1,
                id: &request.id,
                ok: false,
                result: None,
                error: Some(error_code(error)),
            },
        };
        if serde_json::to_writer(&mut output, &response).is_err()
            || output.write_all(b"\n").is_err()
            || output.flush().is_err()
        {
            return false;
        }
    }
}

fn dispatch(authority: &mut JobAuthority, request: &Request) -> Result<Value, AuthorityError> {
    let job_id = || {
        request
            .job_id
            .as_deref()
            .ok_or(AuthorityError::InvalidIdentifier)
    };
    let lease = || request.lease.as_ref().ok_or(AuthorityError::StaleLease);
    match request.method.as_str() {
        "job.create" => serde_json::to_value(authority.create(job_id()?)?)
            .map_err(|_| AuthorityError::InvalidIdentifier),
        "lease.acquire" => serde_json::to_value(
            authority.acquire(
                job_id()?,
                request
                    .owner
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
            )?,
        )
        .map_err(|_| AuthorityError::InvalidIdentifier),
        "job.transition" => serde_json::to_value(authority.transition(
            job_id()?,
            lease()?,
            request.state.ok_or(AuthorityError::InvalidTransition)?,
        )?)
        .map_err(|_| AuthorityError::InvalidIdentifier),
        "event.append" => serde_json::to_value(
            authority.append_event(
                job_id()?,
                lease()?,
                request
                    .event_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .payload
                    .clone()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
            )?,
        )
        .map_err(|_| AuthorityError::InvalidIdentifier),
        "event.replay" => {
            serde_json::to_value(authority.replay(job_id()?, request.after.unwrap_or(0))?)
                .map_err(|_| AuthorityError::InvalidIdentifier)
        }
        "job.reconcile" if request.job_id.is_none() => serde_json::to_value(authority.reconcile())
            .map_err(|_| AuthorityError::InvalidIdentifier),
        _ => Err(AuthorityError::InvalidIdentifier),
    }
}

fn error_code(error: AuthorityError) -> &'static str {
    match error {
        AuthorityError::InvalidIdentifier => "invalid_request",
        AuthorityError::AlreadyExists => "already_exists",
        AuthorityError::NotFound => "not_found",
        AuthorityError::LeaseHeld => "lease_held",
        AuthorityError::StaleLease => "stale_lease",
        AuthorityError::InvalidTransition => "invalid_transition",
        AuthorityError::TerminalJob => "terminal_job",
        AuthorityError::EventConflict => "event_conflict",
    }
}

#[cfg(test)]
mod tests {
    use super::{AuthorityError, JobAuthority, JobState};
    use serde_json::json;

    #[test]
    fn enforces_leases_and_state_transitions() {
        let mut authority = JobAuthority::default();
        assert_eq!(authority.create("job-1").unwrap().state, JobState::Queued);
        let lease = authority.acquire("job-1", "owner-1").unwrap();
        assert_eq!(
            authority
                .transition("job-1", &lease, JobState::Running)
                .unwrap()
                .state,
            JobState::Running
        );
        assert_eq!(
            authority.transition("job-1", &lease, JobState::Queued),
            Err(AuthorityError::InvalidTransition)
        );
        assert_eq!(
            authority
                .transition("job-1", &lease, JobState::Succeeded)
                .unwrap()
                .state,
            JobState::Succeeded
        );
        assert_eq!(
            authority.acquire("job-1", "owner-2"),
            Err(AuthorityError::TerminalJob)
        );
    }

    #[test]
    fn appends_events_idempotently_and_replays_in_order() {
        let mut authority = JobAuthority::default();
        authority.create("job-1").unwrap();
        let lease = authority.acquire("job-1", "owner-1").unwrap();
        let first = authority
            .append_event("job-1", &lease, "event-1", json!({"value": 1}))
            .unwrap();
        assert_eq!(
            authority
                .append_event("job-1", &lease, "event-1", json!({"value": 1}))
                .unwrap(),
            first
        );
        assert_eq!(
            authority.append_event("job-1", &lease, "event-1", json!({"value": 2})),
            Err(AuthorityError::EventConflict)
        );
        authority
            .append_event("job-1", &lease, "event-2", json!({"value": 2}))
            .unwrap();
        let replay = authority.replay("job-1", 1).unwrap();
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].sequence, 2);
    }

    #[test]
    fn reconciles_owned_active_jobs_as_interrupted() {
        let mut authority = JobAuthority::default();
        authority.create("job-b").unwrap();
        authority.create("job-a").unwrap();
        let lease = authority.acquire("job-a", "owner").unwrap();
        authority
            .transition("job-a", &lease, JobState::Running)
            .unwrap();
        let changed = authority.reconcile();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].job_id, "job-a");
        assert_eq!(changed[0].state, JobState::Interrupted);
        assert!(changed[0].lease.is_none());
    }
}
