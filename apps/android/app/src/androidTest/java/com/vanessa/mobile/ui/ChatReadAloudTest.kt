package com.vanessa.mobile.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.vanessa.mobile.ui.theme.VanessaTheme
import com.vanessa.mobile.voice.OfflineTtsPlaybackStatus
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ChatReadAloudTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun responseActionTogglesBetweenReadAloudAndStopWithoutTaskCancellation() {
        val playbackStatus = mutableStateOf(OfflineTtsPlaybackStatus.IDLE)
        var readRequests = 0
        var stopRequests = 0

        composeRule.setContent {
            VanessaTheme {
                ChatScreen(
                    inset = 24.dp,
                    modelLoaded = true,
                    modelBusy = false,
                    assistantBusy = false,
                    prompt = "",
                    messages = listOf(
                        VanessaChatMessage(
                            id = "assistant-turn-1",
                            fromUser = false,
                            text = "The result has been verified.",
                        ),
                    ),
                    response = "The result has been verified.",
                    metrics = "",
                    speechReady = true,
                    speechPlaybackStatus = playbackStatus.value,
                    onPromptChange = {},
                    onSend = {},
                    onListen = {},
                    onSpeakResponse = {
                        readRequests += 1
                        playbackStatus.value = OfflineTtsPlaybackStatus.SPEAKING
                    },
                    onStopSpeechOutput = {
                        stopRequests += 1
                        playbackStatus.value = OfflineTtsPlaybackStatus.STOPPED
                    },
                    onNavigate = {},
                )
            }
        }

        composeRule.onNodeWithContentDescription("Read response aloud")
            .assertIsDisplayed()
            .performClick()
        assertEquals(1, readRequests)

        composeRule.onNodeWithContentDescription("Stop reading aloud")
            .assertIsDisplayed()
            .performClick()
        assertEquals(1, stopRequests)

        // Playback stop returns the card to its read-aloud affordance. The UI
        // action is intentionally disconnected from the task/orchestrator API.
        composeRule.onNodeWithContentDescription("Read response aloud").assertIsDisplayed()
    }
}
