using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace Vanessa.WindowsAudio {
    // IUnknown vtable order is significant. Unused slots are retained through GetMute.
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class DeviceEnumerator { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
        [PreserveSig] int GetId(out IntPtr id);
        [PreserveSig] int GetState(out uint state);
    }
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr callback);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr callback);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid context);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
        [PreserveSig] int GetMasterVolumeLevel(out float level);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }
    public sealed class AudioState {
        public double volumePercent;
        public bool muted;
    }
    public interface IAudioDevice : IDisposable {
        string DeviceId { get; }
        string CurrentDefaultId();
        AudioState Read();
        void SetVolume(double percent);
        void SetMute(bool muted);
    }
    public sealed class CoreAudioDevice : IAudioDevice {
        private IMMDeviceEnumerator enumerator;
        private IMMDevice device;
        private IAudioEndpointVolume volume;
        public string DeviceId { get; private set; }
        private static void Check(int hr, string operation) {
            if (hr < 0) throw new COMException(operation + " failed (HRESULT 0x" + unchecked((uint)hr).ToString("X8") + ")", hr);
        }
        private static string Id(IMMDevice endpoint) {
            IntPtr pointer = IntPtr.Zero;
            try {
                Check(endpoint.GetId(out pointer), "IMMDevice.GetId");
                return Marshal.PtrToStringUni(pointer);
            } finally { if (pointer != IntPtr.Zero) Marshal.FreeCoTaskMem(pointer); }
        }
        public CoreAudioDevice() {
            try {
                enumerator = (IMMDeviceEnumerator)new DeviceEnumerator();
                // eRender = 0; eMultimedia = 1; CLSCTX_ALL = 23.
                Check(enumerator.GetDefaultAudioEndpoint(0, 1, out device), "GetDefaultAudioEndpoint");
                DeviceId = Id(device);
                Guid iid = typeof(IAudioEndpointVolume).GUID;
                object activated;
                Check(device.Activate(ref iid, 23, IntPtr.Zero, out activated), "IMMDevice.Activate");
                volume = (IAudioEndpointVolume)activated;
            } catch { Dispose(); throw; }
        }
        public string CurrentDefaultId() {
            IMMDevice current = null;
            try {
                Check(enumerator.GetDefaultAudioEndpoint(0, 1, out current), "GetDefaultAudioEndpoint");
                return Id(current);
            } finally { Release(current); }
        }
        public AudioState Read() {
            float level;
            bool muted;
            Check(volume.GetMasterVolumeLevelScalar(out level), "GetMasterVolumeLevelScalar");
            Check(volume.GetMute(out muted), "GetMute");
            return new AudioState { volumePercent = level * 100.0, muted = muted };
        }
        public void SetVolume(double percent) {
            if (Double.IsNaN(percent) || Double.IsInfinity(percent) || percent < 0 || percent > 100)
                throw new ArgumentOutOfRangeException("percent");
            Guid context = Guid.Empty;
            Check(volume.SetMasterVolumeLevelScalar((float)(percent / 100.0), ref context), "SetMasterVolumeLevelScalar");
        }
        public void SetMute(bool muted) {
            Guid context = Guid.Empty;
            Check(volume.SetMute(muted, ref context), "SetMute");
        }
        private static void Release(object value) {
            if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
        }
        public void Dispose() {
            Release(volume); volume = null;
            Release(device); device = null;
            Release(enumerator); enumerator = null;
        }
    }

    public sealed class ObservedState { public double volumePercent; public bool muted; }
    public sealed class DeviceIdentity {
        public string id;
        public string flow = "render";
        public string role = "multimedia";
        public string currentDefaultId;
    }
    public sealed class AudioError { public string code; public string message; public string hresult; }
    public sealed class AudioResult {
        public bool success;
        public string operation;
        public Dictionary<string, object> requested;
        public ObservedState observed;
        public DeviceIdentity device;
        public AudioError error;
    }
    public static class AudioControl {
        public static AudioResult Execute(string json) {
            return ExecuteWithFactory(json, delegate { return new CoreAudioDevice(); });
        }
        // Test seam; the default entry point always creates a real Core Audio device.
        public static AudioResult ExecuteWithFactory(string json, Func<IAudioDevice> factory) {
            AudioResult result = new AudioResult();
            IAudioDevice device = null;
            string code = "invalid_input";
            try {
                var serializer = new JavaScriptSerializer();
                var request = serializer.DeserializeObject(json) as Dictionary<string, object>;
                if (request == null) throw new ArgumentException("Request must be a JSON object");
                object value;
                result.operation = request.TryGetValue("operation", out value) ? value as string : null;
                if (result.operation != "get" && result.operation != "setVolume" && result.operation != "setMute")
                    throw new ArgumentException("operation must be get, setVolume, or setMute");
                foreach (string name in request.Keys) {
                    if (name != "operation" && name != "volumePercent" && name != "muted" && name != "expectedDeviceId")
                        throw new ArgumentException("Unknown request property: " + name);
                }
                string expected = null;
                if (request.TryGetValue("expectedDeviceId", out value)) {
                    expected = value as string;
                    if (String.IsNullOrWhiteSpace(expected)) throw new ArgumentException("expectedDeviceId must be a non-empty endpoint ID string");
                }
                double percent = 0;
                bool muted = false;
                if (result.operation == "setVolume") {
                    if (!request.TryGetValue("volumePercent", out value) || !(value is int || value is long || value is decimal || value is double || value is float))
                        throw new ArgumentException("volumePercent must be a finite JSON number from 0 to 100");
                    percent = Convert.ToDouble(value);
                    if (Double.IsNaN(percent) || Double.IsInfinity(percent) || percent < 0 || percent > 100 || request.ContainsKey("muted"))
                        throw new ArgumentException("setVolume requires 0 to 100 and does not accept muted");
                    result.requested = new Dictionary<string, object> { { "volumePercent", percent } };
                } else if (result.operation == "setMute") {
                    if (!request.TryGetValue("muted", out value) || !(value is bool) || request.ContainsKey("volumePercent"))
                        throw new ArgumentException("setMute requires an explicit JSON boolean and does not accept volumePercent");
                    muted = (bool)value;
                    result.requested = new Dictionary<string, object> { { "muted", muted } };
                } else if (request.ContainsKey("muted") || request.ContainsKey("volumePercent")) {
                    throw new ArgumentException("get does not accept a requested state");
                }
                code = "api_failure";
                device = factory();
                if (device == null || String.IsNullOrWhiteSpace(device.DeviceId)) {
                    code = "no_device";
                    throw new InvalidOperationException("No default playback device was returned");
                }
                result.device = new DeviceIdentity { id = device.DeviceId, currentDefaultId = device.CurrentDefaultId() };
                if (result.device.currentDefaultId != device.DeviceId || (expected != null && expected != device.DeviceId)) {
                    code = "device_changed";
                    throw new InvalidOperationException("Default playback device changed or does not match expectedDeviceId");
                }
                if (result.operation == "setVolume") device.SetVolume(percent);
                else if (result.operation == "setMute") device.SetMute(muted);
                result.observed = Observe(device);
                result.device.currentDefaultId = device.CurrentDefaultId();
                if (result.device.currentDefaultId != device.DeviceId) {
                    code = "device_changed";
                    throw new InvalidOperationException("Default playback device changed during execution; observation belongs to the selected device");
                }
                code = "readback_mismatch";
                if (result.operation == "setVolume" && Math.Abs(result.observed.volumePercent - percent) > 0.5)
                    throw new InvalidOperationException("Volume readback differs by more than 0.5 percentage points");
                if (result.operation == "setMute" && result.observed.muted != muted)
                    throw new InvalidOperationException("Mute readback differs from requested state");
                result.success = true;
            } catch (Exception exception) {
                if (exception.HResult == unchecked((int)0x80070490)) code = "no_device";
                result.error = Error(code, exception);
                // An API may fail after changing state: attempt a fresh observation, never invent one.
                if (device != null && result.observed == null) {
                    try { result.observed = Observe(device); } catch { }
                }
            } finally {
                if (device != null) {
                    try { device.Dispose(); }
                    catch (Exception exception) { result.success = false; result.error = Error("api_failure", exception); }
                }
            }
            return result;
        }
        private static ObservedState Observe(IAudioDevice device) {
            AudioState state = device.Read();
            if (state == null || Double.IsNaN(state.volumePercent) || Double.IsInfinity(state.volumePercent) || state.volumePercent < 0 || state.volumePercent > 100)
                throw new InvalidOperationException("Audio API returned invalid state");
            return new ObservedState { volumePercent = state.volumePercent, muted = state.muted };
        }
        private static AudioError Error(string code, Exception exception) {
            return new AudioError { code = code, message = exception.Message, hresult = "0x" + unchecked((uint)exception.HResult).ToString("X8") };
        }
    }
}
