use crate::error::{NativeError, Result};
use serde_json::Value;
#[cfg(unix)]
use std::os::unix::{fs::PermissionsExt, process::CommandExt};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};

const MAX_REQUEST: usize = 1024 * 1024;
const MAX_RESPONSE: usize = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(150);
type Pending = Arc<Mutex<HashMap<String, SyncSender<Result<Value>>>>>;

pub struct ServiceHost {
    binary: PathBuf,
    directory: PathBuf,
    process: Mutex<Option<Arc<ServiceProcess>>>,
    closed: AtomicBool,
}

struct ServiceProcess {
    pid: u32,
    child: Mutex<Option<Child>>,
    input: SyncSender<Vec<u8>>,
    pending: Pending,
    stopped: AtomicBool,
    terminated: (Mutex<bool>, Condvar),
}

fn failure(code: &str, message: &str) -> NativeError {
    NativeError {
        code: code.into(),
        message: message.into(),
        retryable: true,
    }
}

fn validate_request(request: &Value) -> Result<(&str, &str)> {
    let object = request.as_object().ok_or_else(NativeError::invalid)?;
    let id = request["id"].as_str().ok_or_else(NativeError::invalid)?;
    let op = request["op"].as_str().ok_or_else(NativeError::invalid)?;
    if object.len() != 4
        || request["v"] != 1
        || !request["input"].is_object()
        || id.is_empty()
        || id.len() > 180
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        || !matches!(
            op,
            "connection.check"
                | "github.refresh"
                | "github.acknowledge"
                | "github.unsubscribe"
                | "copilot.triage"
                | "copilot.interpretCapture"
                | "copilot.reconsider"
                | "cancel"
        )
    {
        return Err(NativeError::invalid());
    }
    Ok((id, op))
}

fn validate_response(value: &Value) -> Result<&str> {
    let object = value.as_object().ok_or_else(protocol_error)?;
    let id = value["id"].as_str().ok_or_else(protocol_error)?;
    if object.len() != 4 || value["v"] != 1 || id.is_empty() {
        return Err(protocol_error());
    }
    match value["ok"].as_bool() {
        Some(true) if value.get("result").is_some() && value.get("error").is_none() => Ok(id),
        Some(false) if value.get("result").is_none() => {
            let error = value["error"].as_object().ok_or_else(protocol_error)?;
            if error.len() == 3
                && value["error"]["code"].is_string()
                && value["error"]["message"].is_string()
                && value["error"]["retryable"].is_boolean()
            {
                Ok(id)
            } else {
                Err(protocol_error())
            }
        }
        _ => Err(protocol_error()),
    }
}

fn protocol_error() -> NativeError {
    failure("service-protocol", "The service returned an unsupported response. No operation was confirmed; retry explicitly.")
}

impl ServiceHost {
    pub fn new(directory: PathBuf) -> Result<Self> {
        let binary = std::env::current_exe()?
            .parent()
            .ok_or_else(NativeError::invalid)?
            .join("github-projects-service");
        Ok(Self {
            binary,
            directory,
            process: Mutex::new(None),
            closed: AtomicBool::new(false),
        })
    }

    pub fn request(&self, request: Value) -> Result<Value> {
        self.request_with_timeout(request, TIMEOUT)
    }

    fn request_with_timeout(&self, request: Value, timeout: Duration) -> Result<Value> {
        let (id, op) = validate_request(&request)?;
        let mut bytes = serde_json::to_vec(&request).map_err(|_| NativeError::invalid())?;
        if bytes.len() > MAX_REQUEST {
            return Err(NativeError::invalid());
        }
        bytes.push(b'\n');
        let process = {
            let mut current = self.process.lock().map_err(|_| protocol_error())?;
            if self.closed.load(Ordering::SeqCst) {
                return Err(failure(
                    "service-stopped",
                    "The app is shutting down. No new service request was started.",
                ));
            }
            if current
                .as_ref()
                .is_none_or(|process| process.stopped.load(Ordering::SeqCst))
            {
                *current = Some(ServiceProcess::spawn(&self.binary, &self.directory)?);
            }
            current.as_ref().unwrap().clone()
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut pending = process.pending.lock().map_err(|_| protocol_error())?;
            if process.stopped.load(Ordering::SeqCst) {
                return Err(failure(
                    "service-disconnected",
                    "The service stopped before the request could be queued.",
                ));
            }
            let limit = if op == "cancel" { 8 } else { 4 };
            if pending.len() >= limit || pending.contains_key(id) {
                return Err(failure("service-busy", "The service is already handling the maximum number of requests. Retry after one finishes."));
            }
            pending.insert(id.to_owned(), sender);
        }
        if process.input.try_send(bytes).is_err() {
            process
                .pending
                .lock()
                .map_err(|_| protocol_error())?
                .remove(id);
            return Err(failure(
                "service-busy",
                "The service input is unavailable. Nothing was queued; retry explicitly.",
            ));
        }
        match receiver.recv_timeout(timeout) {
            Ok(Ok(result)) => {
                let terminal = result["ok"] == false
                    && matches!(
                        result["error"]["code"].as_str(),
                        Some("cancelled" | "deadline")
                    );
                let cancelled =
                    op == "cancel" && result["ok"] == true && result["result"]["cancelled"] == true;
                if terminal || cancelled {
                    process.shutdown(failure("service-interrupted", "The service interrupted this request before confirmation. A GitHub write may have completed; check GitHub or retry explicitly. Pending local work is retained."));
                }
                Ok(result)
            }
            Ok(Err(error)) => Err(error),
            Err(_) => {
                process.shutdown(failure("service-timeout", "The service timed out and its processes were stopped. A GitHub write may have completed; check or retry explicitly."));
                Err(failure("service-timeout", "The service did not confirm an outcome before its deadline. Pending local work is retained."))
            }
        }
    }

    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut current) = self.process.lock() {
            if let Some(process) = current.take() {
                process.shutdown(failure(
                    "service-stopped",
                    "The service stopped before confirmation. Pending operations are not replayed.",
                ));
            }
        }
    }
}

impl Drop for ServiceHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl ServiceProcess {
    fn spawn(binary: &PathBuf, directory: &PathBuf) -> Result<Arc<Self>> {
        std::fs::create_dir_all(directory)?;
        #[cfg(unix)]
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
        let mut command = Command::new(binary);
        command
            .current_dir(directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|_| failure(
            "service-unavailable", "The packaged GitHub service could not start. Rebuild or reinstall the complete app bundle.",
        ))?;
        let pid = child.id();
        let mut stdin = child.stdin.take().ok_or_else(protocol_error)?;
        let mut stdout = child.stdout.take().ok_or_else(protocol_error)?;
        let mut stderr = child.stderr.take().ok_or_else(protocol_error)?;
        let (input, received) = mpsc::sync_channel::<Vec<u8>>(8);
        let process = Arc::new(Self {
            pid,
            child: Mutex::new(Some(child)),
            input,
            pending: Arc::new(Mutex::new(HashMap::new())),
            stopped: AtomicBool::new(false),
            terminated: (Mutex::new(false), Condvar::new()),
        });
        let writer = process.clone();
        std::thread::spawn(move || {
            while !writer.stopped.load(Ordering::SeqCst) {
                match received.recv_timeout(Duration::from_millis(100)) {
                    Ok(bytes) => {
                        if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
                            writer.shutdown(failure(
                                "service-disconnected",
                                "The service input closed before confirmation.",
                            ));
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => break,
                }
            }
        });
        let reader = process.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            let mut frame = Vec::new();
            loop {
                let size = match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => {
                        reader.shutdown(protocol_error());
                        break;
                    }
                    Ok(size) => size,
                };
                for byte in &chunk[..size] {
                    if *byte == b'\n' {
                        let response =
                            serde_json::from_slice::<Value>(&frame).map_err(|_| protocol_error());
                        frame.clear();
                        let result = response.and_then(|value| {
                            let id = validate_response(&value)?;
                            let sender = reader
                                .pending
                                .lock()
                                .map_err(|_| protocol_error())?
                                .remove(id)
                                .ok_or_else(protocol_error)?;
                            sender.send(Ok(value)).map_err(|_| protocol_error())
                        });
                        if let Err(error) = result {
                            reader.shutdown(error);
                            return;
                        }
                    } else {
                        frame.push(*byte);
                        if frame.len() > MAX_RESPONSE {
                            reader.shutdown(protocol_error());
                            return;
                        }
                    }
                }
            }
        });
        let errors = process.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            let mut total = 0usize;
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        total += size;
                        if total > 4 * 1024 * 1024 {
                            errors.shutdown(failure(
                                "service-output-limit",
                                "The service exceeded its diagnostic output limit and was stopped.",
                            ));
                            break;
                        }
                    }
                }
            }
        });
        Ok(process)
    }

    fn shutdown(&self, error: NativeError) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            let (finished, signal) = &self.terminated;
            if let Ok(finished) = finished.lock() {
                drop(signal.wait_while(finished, |finished| !*finished));
            }
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.try_send(Err(error.clone()));
            }
        }
        #[cfg(unix)]
        {
            // The unreaped group leader reserves this ID until the entire owned group is killed.
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGTERM);
            }
            std::thread::sleep(Duration::from_millis(250));
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                #[cfg(not(unix))]
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        let (finished, signal) = &self.terminated;
        if let Ok(mut finished) = finished.lock() {
            *finished = true;
            signal.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unknown_operations_and_malformed_envelopes() {
        assert!(
            validate_request(&json!({"v":1,"id":"one","op":"github.refresh","input":{}})).is_ok()
        );
        for value in [
            json!({"v":1,"id":"one","op":"shell","input":{"command":"whoami"}}),
            json!({"v":1,"id":"one","op":"github.refresh","input":{},"path":"/tmp"}),
            json!({"v":2,"id":"one","op":"github.refresh","input":{}}),
            json!({"v":1,"id":"one\ninjected","op":"github.refresh","input":{}}),
        ] {
            assert!(validate_request(&value).is_err());
        }
    }

    #[test]
    fn rejects_unknown_outputs_and_missing_response_identity() {
        assert!(validate_response(&json!({"v":1,"id":"one","ok":true,"result":{}})).is_ok());
        for value in [
            json!({"v":1,"id":null,"ok":true,"result":{}}),
            json!({"v":1,"id":"one","ok":true,"result":{},"extra":"secret"}),
            json!({"v":1,"id":"one","ok":false,"error":{"message":"unknown"}}),
            json!({"v":1,"id":"one","ok":true,"error":{}}),
        ] {
            assert!(validate_response(&value).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn owned_process_reads_framed_output_and_shutdown_reaps_its_leader() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("test-service");
        std::fs::write(&binary, "#!/bin/sh\nread input\nprintf '%s\\n' '{\"v\":1,\"id\":\"test\",\"ok\":true,\"result\":{}}'\nread input\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let host = ServiceHost {
            binary,
            directory: directory.path().join("private"),
            process: Mutex::new(None),
            closed: AtomicBool::new(false),
        };
        let result = host
            .request(json!({"v":1,"id":"test","op":"github.refresh","input":{}}))
            .unwrap();
        assert_eq!(result["ok"], true);
        let process = host.process.lock().unwrap().as_ref().unwrap().clone();
        host.shutdown();
        assert!(process.stopped.load(Ordering::SeqCst));
        assert!(process.child.lock().unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn mismatched_response_id_stops_the_owned_service() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("test-service");
        std::fs::write(&binary, "#!/bin/sh\nread input\nprintf '%s\\n' '{\"v\":1,\"id\":\"wrong\",\"ok\":true,\"result\":{}}'\nread input\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let host = ServiceHost {
            binary,
            directory: directory.path().join("private"),
            process: Mutex::new(None),
            closed: AtomicBool::new(false),
        };
        assert!(host
            .request_with_timeout(
                json!({"v":1,"id":"test","op":"github.refresh","input":{}}),
                Duration::from_secs(2)
            )
            .is_err());
        host.shutdown();
        assert!(host.process.lock().unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn blocked_stdin_and_resistant_process_do_not_outlive_request_timeout() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("test-service");
        std::fs::write(
            &binary,
            "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let host = ServiceHost {
            binary,
            directory: directory.path().join("private"),
            process: Mutex::new(None),
            closed: AtomicBool::new(false),
        };
        let started = std::time::Instant::now();
        let result = host.request_with_timeout(json!({"v":1,"id":"test","op":"copilot.interpretCapture","input":{"text":"x".repeat(200_000)}}), Duration::from_millis(50));
        assert_eq!(result.unwrap_err().code, "service-timeout");
        assert!(started.elapsed() < Duration::from_secs(2));
        let process = host.process.lock().unwrap().as_ref().unwrap().clone();
        host.shutdown();
        assert!(process.child.lock().unwrap().is_none());
    }

    #[cfg(unix)]
    fn fixture(script: &str) -> (tempfile::TempDir, Arc<ServiceHost>) {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("test-service");
        std::fs::write(&binary, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let host = Arc::new(ServiceHost {
            binary,
            directory: directory.path().join("private"),
            process: Mutex::new(None),
            closed: AtomicBool::new(false),
        });
        (directory, host)
    }

    #[cfg(unix)]
    fn wait_file(host: &ServiceHost, name: &str) {
        for _ in 0..200 {
            if host.directory.join(name).exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        host.shutdown();
        panic!("Synthetic service did not receive the expected request.");
    }

    #[cfg(unix)]
    fn assert_owned_group_gone(host: &ServiceHost, process: &ServiceProcess) {
        let descendant: i32 = std::fs::read_to_string(host.directory.join("descendant"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut gone = false;
        for _ in 0..200 {
            if unsafe { libc::kill(-(process.pid as i32), 0) } == -1
                && unsafe { libc::kill(descendant, 0) } == -1
            {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !gone {
            process.shutdown(failure(
                "test-cleanup",
                "Clean up the failed process-group regression.",
            ));
        }
        assert!(
            gone,
            "The owned group or its SIGTERM-resistant descendant survived cancellation."
        );
        assert!(process.child.lock().unwrap().is_none());
    }

    #[cfg(unix)]
    const RESISTANT_DESCENDANT: &str = "trap '' TERM\n/bin/sh -c 'trap \"\" TERM; while :; do /bin/sleep 1; done' &\nprintf '%s' \"$!\" > descendant";

    #[cfg(unix)]
    #[test]
    fn acknowledged_active_cancel_kills_descendants_interrupts_peers_and_restarts_cleanly() {
        let script = format!("{RESISTANT_DESCENDANT}\nread request\ntouch peer-ready\nread request\ntouch target-ready\nread request\nprintf '%s\\n' '{{\"v\":1,\"id\":\"cancel\",\"ok\":true,\"result\":{{\"requestId\":\"target\",\"cancelled\":true}}}}'\nwhile read request; do :; done");
        let (_directory, host) = fixture(&script);
        let peer_host = host.clone();
        let peer = std::thread::spawn(move || {
            peer_host.request(json!({"v":1,"id":"peer","op":"github.acknowledge","input":{}}))
        });
        wait_file(&host, "peer-ready");
        let target_host = host.clone();
        let target = std::thread::spawn(move || {
            target_host.request(json!({"v":1,"id":"target","op":"copilot.triage","input":{}}))
        });
        wait_file(&host, "target-ready");
        let process = host.process.lock().unwrap().as_ref().unwrap().clone();
        let result = host
            .request(json!({"v":1,"id":"cancel","op":"cancel","input":{"requestId":"target"}}))
            .unwrap();
        assert_eq!(result["result"]["cancelled"], true);
        assert_owned_group_gone(&host, &process);
        let error = peer.join().unwrap().unwrap_err();
        assert_eq!(error.code, "service-interrupted");
        assert!(error.message.contains("may have completed"));
        assert_eq!(
            target.join().unwrap().unwrap_err().code,
            "service-interrupted"
        );
        std::fs::write(&host.binary, "#!/bin/sh\nread request\nprintf '%s\\n' '{\"v\":1,\"id\":\"next\",\"ok\":true,\"result\":{}}'\nread request\n").unwrap();
        assert_eq!(
            host.request(json!({"v":1,"id":"next","op":"github.refresh","input":{}}))
                .unwrap()["ok"],
            true
        );
        assert_ne!(
            host.process.lock().unwrap().as_ref().unwrap().pid,
            process.pid
        );
        host.shutdown();
    }

    #[cfg(unix)]
    #[test]
    fn service_cancelled_and_deadline_results_kill_the_entire_owned_group() {
        for code in ["cancelled", "deadline"] {
            let script = format!("{RESISTANT_DESCENDANT}\nread request\nprintf '%s\\n' '{{\"v\":1,\"id\":\"target\",\"ok\":false,\"error\":{{\"code\":\"{code}\",\"message\":\"Synthetic terminal result\",\"retryable\":true}}}}'\nwhile read request; do :; done");
            let (_directory, host) = fixture(&script);
            let result = host
                .request(json!({"v":1,"id":"target","op":"copilot.triage","input":{}}))
                .unwrap();
            assert_eq!(result["error"]["code"], code);
            let process = host.process.lock().unwrap().as_ref().unwrap().clone();
            assert_owned_group_gone(&host, &process);
            host.shutdown();
        }
    }

    #[cfg(unix)]
    #[test]
    fn late_noop_cancel_does_not_interrupt_an_unrelated_write() {
        let (_directory, host) = fixture("read request\nprintf '%s\\n' '{\"v\":1,\"id\":\"finished\",\"ok\":true,\"result\":{}}'\nread request\ntouch peer-ready\nread request\nprintf '%s\\n' '{\"v\":1,\"id\":\"cancel\",\"ok\":true,\"result\":{\"requestId\":\"finished\",\"cancelled\":false}}'\nprintf '%s\\n' '{\"v\":1,\"id\":\"peer\",\"ok\":true,\"result\":{\"status\":\"confirmed\"}}'\nread request");
        host.request(json!({"v":1,"id":"finished","op":"copilot.triage","input":{}}))
            .unwrap();
        let peer_host = host.clone();
        let peer = std::thread::spawn(move || {
            peer_host.request(json!({"v":1,"id":"peer","op":"github.acknowledge","input":{}}))
        });
        wait_file(&host, "peer-ready");
        let process = host.process.lock().unwrap().as_ref().unwrap().clone();
        let result = host
            .request(json!({"v":1,"id":"cancel","op":"cancel","input":{"requestId":"finished"}}))
            .unwrap();
        assert_eq!(result["result"]["cancelled"], false);
        assert!(!process.stopped.load(Ordering::SeqCst));
        assert_eq!(
            peer.join().unwrap().unwrap()["result"]["status"],
            "confirmed"
        );
        host.shutdown();
    }

    #[cfg(unix)]
    #[test]
    fn quit_prevents_queued_or_late_requests_from_spawning_a_new_group() {
        let (_directory, host) = fixture("read request");
        let locked = host.process.lock().unwrap();
        let (attempted, waiting) = mpsc::sync_channel(1);
        let late = host.clone();
        let queued = std::thread::spawn(move || {
            attempted.send(()).unwrap();
            late.request_with_timeout(
                json!({"v":1,"id":"late","op":"github.refresh","input":{}}),
                Duration::from_millis(30),
            )
        });
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        assert!(!queued.is_finished());
        let closing = host.clone();
        let shutdown = std::thread::spawn(move || closing.shutdown());
        while !host.closed.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        drop(locked);
        let result = queued.join().unwrap();
        shutdown.join().unwrap();
        host.shutdown();
        assert_eq!(result.unwrap_err().code, "service-stopped");
        assert_eq!(
            host.request(json!({"v":1,"id":"after-quit","op":"github.refresh","input":{}}))
                .unwrap_err()
                .code,
            "service-stopped"
        );
        assert!(host.process.lock().unwrap().is_none());
        assert!(!host.directory.exists());
    }
}
