#[cfg(target_os = "macos")]
pub struct BackgroundActivity {
    process: objc2::rc::Retained<objc2_foundation::NSProcessInfo>,
    activity:
        objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>,
}

#[cfg(target_os = "macos")]
impl BackgroundActivity {
    pub fn begin() -> Self {
        use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
        let process = NSProcessInfo::processInfo();
        let activity = process.beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
            &NSString::from_str(
                "Keep saved local reminders running while the workspace window is hidden",
            ),
        );
        Self { process, activity }
    }
}

#[cfg(target_os = "macos")]
impl Drop for BackgroundActivity {
    fn drop(&mut self) {
        // The token comes from this exact NSProcessInfo beginActivity call.
        unsafe { self.process.endActivity(&self.activity) };
    }
}

#[cfg(not(target_os = "macos"))]
pub struct BackgroundActivity;
#[cfg(not(target_os = "macos"))]
impl BackgroundActivity {
    pub fn begin() -> Self {
        Self
    }
}
