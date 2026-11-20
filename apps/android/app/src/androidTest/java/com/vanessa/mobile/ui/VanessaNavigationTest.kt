package com.vanessa.mobile.ui

import android.Manifest
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.GrantPermissionRule
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * End-user navigation checks on an Android emulator.
 *
 * This test deliberately runs without a local GGUF file or native runtime.
 * That is the clean-install compatibility path: the app must remain navigable,
 * must reach the assistant surface through the first-run flow, and must not
 * claim that a request ran when no model is available.
 *
 * Onboarding is persisted in SharedPreferences, so it appears in the first
 * test of a fresh install and not in later ones. Every test therefore walks
 * the flow only as far as it actually needs to.
 */
@RunWith(AndroidJUnit4::class)
class VanessaNavigationTest {

    @get:Rule(order = 0)
    val microphonePermission: GrantPermissionRule =
        GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO)

    @get:Rule(order = 1)
    val composeRule = createAndroidComposeRule<MainActivity>()

    private fun exists(text: String): Boolean = runCatching {
        composeRule.onAllNodesWithText(text).fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()
    }.getOrDefault(false)

    private fun clickText(text: String) {
        composeRule.onAllNodesWithText(text)[0].performClick()
        composeRule.waitForIdle()
    }

    /**
     * Walks Welcome → Onboarding → Permissions when they are showing, and
     * stops on the assistant. "Not now" is used rather than "Allow All" so the
     * test never sits behind a system permission dialog; the microphone grant
     * rule already covers the permission this build needs.
     */
    /**
     * Every text the semantics tree currently exposes. Marker checks answer
     * "is the screen I expected here"; this answers "what is here", which is the
     * question that matters when the walk stops somewhere unexpected.
     */
    private fun screenText(): String = runCatching {
        composeRule.onAllNodes(hasText("", substring = true))
            .fetchSemanticsNodes()
            .mapNotNull { node ->
                node.config.getOrNull(SemanticsProperties.Text)
                    ?.joinToString(" ") { span -> span.text }
                    ?.takeIf { it.isNotBlank() }
            }
            .distinct()
            .take(12)
            .joinToString(" / ")
    }.getOrDefault("unavailable")

    /** What is on screen, for a failure message that can be read in CI. */
    private fun describeScreen(): String {
        val markers = listOf(
            "Initializing Vanessa…",
            "Checking this device…",
            "Detecting the installed local model…",
            "Starting the local model…",
            "Vanessa is open. Some local features are unavailable.",
            "Get Started",
            "Continue",
            "Allow microphone",
            "Not now",
            "How can I help?",
            "No local model is active.",
            "Type a message…",
        ).filter { exists(it) }
        val composer = runCatching {
            composeRule.onAllNodesWithContentDescription("Open actions").fetchSemanticsNodes().size
        }.getOrDefault(-1)
        return "visible: " + markers.joinToString(", ").ifEmpty { "none of the known screens" } +
            "; composer menus: $composer; text: " + screenText()
    }

    private fun enterAssistant() {
        try {
            composeRule.waitUntil(timeoutMillis = 60_000) {
                exists("How can I help?") || exists("Get Started")
            }
        } catch (timeout: Throwable) {
            throw AssertionError("No first screen after 60s. " + describeScreen())
        }
        // Step through the first-run screens until the composer exists. A
        // single pass over the labels races the recomposition that follows
        // each tap, which made this flaky under a loaded emulator.
        var guard = 0
        while (!composerVisible() && guard < 12) {
            guard += 1
            when {
                exists("Get Started") -> clickText("Get Started")
                exists("Allow microphone") -> clickText("Not now")
                exists("Not now") -> clickText("Not now")
                exists("Continue") -> clickText("Continue")
                else -> composeRule.waitForIdle()
            }
        }
        try {
            composeRule.waitUntil(timeoutMillis = 60_000) { composerVisible() }
        } catch (timeout: Throwable) {
            throw AssertionError(
                "The composer never appeared after " + guard + " first-run taps. " + describeScreen(),
            )
        }
    }

    /**
     * The composer is present on the assistant surface regardless of whether a
     * response is showing, so it is a stable "we are home" signal — unlike the
     * greeting, which the first answer replaces.
     */
    private fun composerVisible(): Boolean = runCatching {
        // Anchored on the composer's own menu button rather than on
        // `onAllNodes(hasSetTextAction())`: that call did not resolve against this
        // Compose version, so the whole instrumented source set failed to compile
        // and every emulator run for months reported "no tests" instead of a
        // compile error. A content description that exists only in the composer is
        // a narrower signal anyway.
        composeRule.onAllNodesWithContentDescription("Open actions").fetchSemanticsNodes().isNotEmpty()
    }.getOrDefault(false)

    @Test
    fun firstRunFlowReachesTheAssistantWithoutClaimingAModel() {
        enterAssistant()

        composeRule.onNodeWithText("How can I help?").assertIsDisplayed()
        composeRule.onNodeWithText("Add a local model in Settings to start a conversation.").assertIsDisplayed()
        composeRule.onNodeWithText(
            "No local model is active. Vanessa will not run a request until a model is installed.",
        ).assertIsDisplayed()

        // The orb is the brand mark and is drawn as its own composable, so it
        // must expose a description for TalkBack.
        composeRule.onNodeWithContentDescription("Vanessa orb, idle").assertIsDisplayed()
    }

    @Test
    fun typedInputIsAcceptedButCannotRunWithoutAModel() {
        enterAssistant()

        // Assert against the editable node and the notice node, never against
        // the message text itself: once the chat echoes the prompt in a bubble,
        // two nodes carry it and a unique-node matcher fails intermittently.
        composeRule.onNode(hasSetTextAction()).performTextInput("Check my messages")
        composeRule.onNode(hasSetTextAction()).assertTextContains("Check my messages")

        // No model is installed, so the composer's send control stays inert and
        // the interface keeps saying so. The request must not appear to run.
        // Existence, not visibility: with the soft keyboard up the notice can
        // sit outside the visible area without being wrong.
        composeRule.onNodeWithText(
            "No local model is active. Vanessa will not run a request until a model is installed.",
        ).assertExists()
        composeRule.onAllNodesWithText("All set!").assertCountEquals(0)
    }

    @Test
    fun voiceSurfaceIsReachableAndDismissible() {
        enterAssistant()

        composeRule.onNodeWithContentDescription("Start voice interaction").performClick()
        composeRule.waitForIdle()

        // "I'm listening…" only appears when the recogniser actually started;
        // a device without one shows the honest idle title instead.
        val startedListening = composeRule.onAllNodesWithText("I'm listening…")
            .fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()
        if (!startedListening) {
            composeRule.onNodeWithText("Voice input").assertIsDisplayed()
        }

        composeRule.onNodeWithContentDescription("Close voice input").performClick()
        composeRule.waitUntil(timeoutMillis = 30_000) { composerVisible() }
    }

    @Test
    fun pcDashboardKeepsTheRealRemoteControlEntryPoint() {
        enterAssistant()

        composeRule.onNodeWithContentDescription("Open navigation menu").performClick()
        composeRule.onNodeWithText("My PC").performClick()
        composeRule.onAllNodesWithText("Windows companion")[0].assertIsDisplayed()
        composeRule.onNodeWithText("Pair with Windows").performClick()
        composeRule.onNodeWithText("Scan PC pairing code").assertIsDisplayed()
        composeRule.onNodeWithText(
            "The remote control screen verifies the PC identity and completes authenticated v2 pairing. New phones require local approval on the PC.",
        ).assertIsDisplayed()
    }

    @Test
    fun settingsIsReachableAndScrollable() {
        enterAssistant()

        // Regression guard: Settings used to exist only as unreachable dead
        // code, so this assertion is what keeps the shell wired up.
        composeRule.onNodeWithContentDescription("Open navigation menu").performClick()
        composeRule.onNodeWithText("Settings").performClick()

        composeRule.onNodeWithText("PREFERENCES").assertIsDisplayed()
        composeRule.onNodeWithText("LOCAL MODEL").assertIsDisplayed()
        composeRule.onNodeWithText("Expected SHA-256 (optional)").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText("Import GGUF").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText("THIS DEVICE").performScrollTo()
        composeRule.onNodeWithText("ABOUT").performScrollTo()
        composeRule.onNodeWithText("Vanessa Android").performScrollTo().assertIsDisplayed()

        composeRule.onNodeWithContentDescription("Home navigation").assertIsDisplayed()
    }
}
