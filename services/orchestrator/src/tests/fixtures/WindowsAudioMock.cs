
namespace Vanessa.WindowsAudio {
    // These tests compile with the real adapter but never instantiate CoreAudioDevice.
    public sealed class FakeAudioDevice : IAudioDevice {
        public string DeviceId { get { return "fake-device"; } }
        public string Mode = "normal";
        public double Volume = 55;
        public bool Muted;
        public int Sets, Reads, Defaults;
        public bool Disposed;
        public string CurrentDefaultId() {
            Defaults++;
            return Mode == "changedBefore" || (Mode == "changedAfter" && Defaults > 1) ? "new-device" : DeviceId;
        }
        public AudioState Read() {
            Reads++;
            if (Mode == "readFailure") throw new System.Runtime.InteropServices.COMException("Mock GetMute failure", unchecked((int)0x80004005));
            return new AudioState { volumePercent = Mode == "invalidReadback" ? System.Double.NaN : Volume, muted = Muted };
        }
        public void SetVolume(double percent) {
            Sets++;
            if (Mode == "apiFailure") throw new System.Runtime.InteropServices.COMException("Mock SetMasterVolumeLevelScalar failure", unchecked((int)0x80004005));
            if (Mode != "mismatch") Volume = System.Math.Min(100, percent + 0.25);
        }
        public void SetMute(bool muted) {
            Sets++;
            if (Mode == "apiFailure") throw new System.Runtime.InteropServices.COMException("Mock SetMute failure", unchecked((int)0x80004005));
            if (Mode != "mismatch") Muted = muted;
        }
        public void Dispose() { Disposed = true; }
    }
    public static class MockTests {
        private static void Assert(bool condition, string message) {
            if (!condition) throw new System.Exception(message);
        }
        public static System.Collections.Generic.Dictionary<string, int> Run() {
            int checks = 0;
            foreach (string json in new [] {
                "{}", "null", "[]", "{broken", "{\"operation\":\"other\"}",
                "{\"operation\":\"setVolume\"}",
                "{\"operation\":\"setVolume\",\"volumePercent\":-1}",
                "{\"operation\":\"setVolume\",\"volumePercent\":101}",
                "{\"operation\":\"setVolume\",\"volumePercent\":\"30\"}",
                "{\"operation\":\"setVolume\",\"volumePercent\":true}",
                "{\"operation\":\"setVolume\",\"volumePercent\":null}",
                "{\"operation\":\"setMute\",\"muted\":\"false\"}",
                "{\"operation\":\"setMute\"}",
                "{\"operation\":\"get\",\"muted\":false}",
                "{\"operation\":\"get\",\"extra\":1}",
                "{\"operation\":\"get\",\"expectedDeviceId\":\"\"}"
            }) {
                bool factoryCalled = false;
                AudioResult invalid = AudioControl.ExecuteWithFactory(json, delegate { factoryCalled = true; return new FakeAudioDevice(); });
                Assert(!invalid.success && invalid.error.code == "invalid_input" && !factoryCalled, "Invalid request accepted: " + json);
                checks++;
            }
            FakeAudioDevice fake = new FakeAudioDevice();
            AudioResult result = AudioControl.ExecuteWithFactory("{\"operation\":\"get\"}", delegate { return fake; });
            Assert(result.success && result.observed.volumePercent == 55 && !result.observed.muted && fake.Sets == 0 && fake.Disposed, "Read-only contract failed"); checks++;
            foreach (double percent in new [] { 0.0, 30.0, 99.5, 100.0 }) {
                fake = new FakeAudioDevice();
                result = AudioControl.ExecuteWithFactory("{\"operation\":\"setVolume\",\"volumePercent\":" + percent.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}", delegate { return fake; });
                Assert(result.success && fake.Sets == 1 && fake.Reads == 1 && (double)result.requested["volumePercent"] == percent && result.observed.volumePercent == System.Math.Min(100, percent + 0.25), "Volume readback/tolerance failed"); checks++;
            }
            foreach (bool muted in new [] { true, false }) {
                fake = new FakeAudioDevice { Muted = !muted };
                result = AudioControl.ExecuteWithFactory("{\"operation\":\"setMute\",\"muted\":" + muted.ToString().ToLowerInvariant() + "}", delegate { return fake; });
                Assert(result.success && result.observed.muted == muted && result.observed.volumePercent == 55 && fake.Reads == 1, "Mute readback failed"); checks++;
            }
            foreach (string request in new [] { "{\"operation\":\"setVolume\",\"volumePercent\":30}", "{\"operation\":\"setMute\",\"muted\":true}" }) {
                fake = new FakeAudioDevice { Mode = "mismatch" };
                result = AudioControl.ExecuteWithFactory(request, delegate { return fake; });
                Assert(!result.success && result.error.code == "readback_mismatch", "Readback mismatch reported success"); checks++;
                fake = new FakeAudioDevice { Mode = "apiFailure" };
                result = AudioControl.ExecuteWithFactory(request, delegate { return fake; });
                Assert(!result.success && result.error.code == "api_failure" && result.observed.volumePercent == 55 && result.error.hresult == "0x80004005", "API failure invented state"); checks++;
            }
            foreach (string mode in new [] { "readFailure", "invalidReadback" }) {
                fake = new FakeAudioDevice { Mode = mode };
                result = AudioControl.ExecuteWithFactory("{\"operation\":\"get\"}", delegate { return fake; });
                Assert(!result.success && result.observed == null && result.error.code == "api_failure", "Invalid read reported success"); checks++;
            }
            result = AudioControl.ExecuteWithFactory("{\"operation\":\"get\"}", delegate { return null; });
            Assert(!result.success && result.error.code == "no_device", "Missing device reported success"); checks++;
            result = AudioControl.ExecuteWithFactory("{\"operation\":\"get\"}", delegate { throw new System.Runtime.InteropServices.COMException("Mock no endpoint", unchecked((int)0x80070490)); });
            Assert(!result.success && result.error.code == "no_device", "Missing endpoint HRESULT misclassified"); checks++;
            foreach (string mode in new [] { "changedBefore", "changedAfter" }) {
                fake = new FakeAudioDevice { Mode = mode };
                result = AudioControl.ExecuteWithFactory("{\"operation\":\"setVolume\",\"volumePercent\":30}", delegate { return fake; });
                Assert(!result.success && result.error.code == "device_changed", "Device switch reported success");
                if (mode == "changedBefore") Assert(fake.Sets == 0, "Changed default was mutated");
                checks++;
            }
            fake = new FakeAudioDevice();
            result = AudioControl.ExecuteWithFactory("{\"operation\":\"setMute\",\"muted\":true,\"expectedDeviceId\":\"old-device\"}", delegate { return fake; });
            Assert(!result.success && result.error.code == "device_changed" && fake.Sets == 0, "Expected-device guard failed"); checks++;
            return new System.Collections.Generic.Dictionary<string, int> { { "mockedChecks", checks }, { "realMutations", 0 } };
        }
    }
}
