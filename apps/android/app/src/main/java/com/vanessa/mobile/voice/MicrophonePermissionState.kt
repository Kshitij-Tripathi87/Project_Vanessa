package com.vanessa.mobile.voice

import androidx.lifecycle.ViewModel

/** Keep the outstanding-dialog fence across Activity recreation (for example rotation). */
internal class MicrophonePermissionState : ViewModel() {
    val gate = MicrophonePermissionGate()
}
