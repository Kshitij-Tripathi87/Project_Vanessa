# Mobile Companion and Local Mobile Agent

**Platforms:** Android and iOS. React Native/Expo is the proposed implementation; current-state report says the mobile scaffold has not started.

## Responsibilities
Push-to-talk, target selection, task progress, approval UI, supported cancellation and phone-local tasks such as in-app notes/reminders using permitted platform APIs.

## Routing
Each request targets this phone, a paired PC or an integrated service. Never silently execute a PC task on phone or vice versa. Ask if target ambiguous.

## Constraints
Do not promise unrestricted system Wi-Fi/Bluetooth control, arbitrary third-party app control or unlimited background microphone access. Use documented capabilities. Store device credentials using OS-backed secure storage; Fish/model API keys stay server-side.

## Tests
Phone-local reminder works while PC offline; remote task uses selected PC; reconnect doesn't duplicate; approval binds to task/device; revoked device rejected; no API key in mobile bundle.