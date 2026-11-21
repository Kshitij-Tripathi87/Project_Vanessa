package com.vanessa.mobile.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.vanessa.mobile.ui.screens.MyPcScreen
import com.vanessa.mobile.ui.state.PcUiState
import com.vanessa.mobile.ui.theme.VanessaTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the refactored pairing screen without opening a real PC connection. */
@RunWith(AndroidJUnit4::class)
class MyPcPairingInputTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun pastedPairDataKeepsItsAccessibleNameAndReachesThePairAction() {
        var submitted = ""
        composeRule.setContent {
            var payload by remember { mutableStateOf("") }
            VanessaTheme {
                MyPcScreen(
                    state = PcUiState(),
                    qrPayload = payload,
                    onQrPayloadChange = { payload = it },
                    onScanQr = {},
                    onPairWithPastedData = { submitted = payload },
                    onReconnect = {},
                    onDisconnect = {},
                    onRunCapability = {},
                    busy = false,
                    onBack = {},
                )
            }
        }

        composeRule.onNodeWithText("Paste pair data instead").performScrollTo().performClick()
        composeRule.onNodeWithContentDescription("PC pair data")
            .performScrollTo().performTextInput("test pairing payload")
        composeRule.onNodeWithContentDescription("PC pair data").assertTextContains("test pairing payload")
        composeRule.onNodeWithText("Pair with this data").performScrollTo().assertIsEnabled().performClick()
        composeRule.runOnIdle { assertEquals("test pairing payload", submitted) }
    }
}
