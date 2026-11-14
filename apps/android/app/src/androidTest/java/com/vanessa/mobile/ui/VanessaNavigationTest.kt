package com.vanessa.mobile.ui

import android.Manifest
import androidx.compose.ui.test.assertDoesNotExist
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.fetchSemanticsNodes
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.GrantPermissionRule
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * End-user navigation checks on an Android emulator.
 *
 * This test deliberately runs without a local GGUF file or native arm64 runtime.
 * That is the clean-install compatibility path: the app must remain navigable,
 * clearly report that inference is unavailable, and must not claim a task ran.
 */
@RunWith(AndroidJUnit4::class)
class VanessaNavigationTest {

    @get:Rule(order = 0)
    val microphonePermission: GrantPermissionRule =
        GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO)

    @get:Rule(order = 1)
    val composeRule = createAndroidComposeRule<MainActivity>()

    private fun waitForHome() {
        composeRule.waitUntil(timeoutMillis = 30_000) {
            composeRule.onAllNodesWithText("How can I help?").fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun homeShowsLocalStateAndDeviceRowsWithoutSetupCatalogues() {
        waitForHome()

        composeRule.onNodeWithText("How can I help?").assertIsDisplayed()
        composeRule.onNodeWithText("MY DEVICES").assertIsDisplayed()
        composeRule.onNodeWithText("On device").assertIsDisplayed()
        composeRule.onNodeWithText("My PC").assertIsDisplayed()
        composeRule.onNodeWithText("No local model detected").assertIsDisplayed()

        // The simplified prototype intentionally removes setup/import and
        // capabilities catalogue screens.
        composeRule.onNodeWithText("Import GGUF").assertDoesNotExist()
        composeRule.onNodeWithText("Capabilities").assertDoesNotExist()
    }

    @Test
    fun voiceScreenKeepsTypedInputWhenNoModelIsAvailable() {
        waitForHome()

        composeRule.onNodeWithContentDescription("Start voice interaction").performClick()
        composeRule.onNodeWithText("Speak a command or type instead.").assertIsDisplayed()
        composeRule.onNodeWithText("Type your request…").performTextInput("Check my phone status")
        composeRule.onNodeWithText("Check my phone status").assertIsDisplayed()

        // No model is installed in this emulator test. The action must stay
        // disabled and the UI must explain that the request has not run.
        composeRule.onNodeWithContentDescription("Send request").assertIsNotEnabled()
        composeRule.onNodeWithText(
            "No active local model. Your request will not run until the model is available."
        ).assertIsDisplayed()
    }

    @Test
    fun pcDashboardAndPairingShowTheUnavailableBoundaryTruthfully() {
        waitForHome()

        composeRule.onNodeWithText("My PC").performClick()
        composeRule.onNodeWithText("No PC paired").assertIsDisplayed()
        composeRule.onNodeWithText("Pair with Windows").performClick()
        composeRule.onNodeWithText("Secure pairing unavailable").assertIsDisplayed()
        composeRule.onNodeWithText(
            "This prototype build does not yet expose the authenticated v2 pairing flow."
        ).assertIsDisplayed()

        composeRule.onNodeWithText("Secure pairing unavailable").performClick()
        composeRule.onNodeWithText(
            "Secure Windows pairing is not enabled in this Android build. No device has been paired."
        ).assertIsDisplayed()

        composeRule.onNodeWithContentDescription("Back").performClick()
        composeRule.onNodeWithText("No PC paired").assertIsDisplayed()
    }

    @Test
    fun settingsIsReachableAndScrollable() {
        waitForHome()

        composeRule.onNodeWithContentDescription("Open navigation menu").performClick()
        composeRule.onNodeWithText("Settings").performClick()

        composeRule.onNodeWithText("Settings").assertIsDisplayed()
        composeRule.onNodeWithText("LOCAL MODEL").assertIsDisplayed()
        composeRule.onNodeWithText("VOICE").assertIsDisplayed()
        composeRule.onNodeWithText("THIS DEVICE").performScrollTo()
        composeRule.onNodeWithText("ABOUT").performScrollTo()
        composeRule.onNodeWithText("Vanessa Android").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText("Development prototype").performScrollTo().assertIsDisplayed()
    }
}
