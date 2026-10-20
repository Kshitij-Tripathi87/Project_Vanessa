Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToWaveFile("$PSScriptRoot\..\test_wifi.wav")
$synth.Speak("Hey Vanessa, restart my Wi-Fi")
$synth.Dispose()

$synth2 = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth2.SetOutputToWaveFile("$PSScriptRoot\..\test_youtube.wav")
$synth2.Speak("Turn on Bluetooth and play lofi on YouTube")
$synth2.Dispose()

$synth3 = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth3.SetOutputToWaveFile("$PSScriptRoot\..\test_claude.wav")
$synth3.Speak("Open Claude Code and build a landing page")
$synth3.Dispose()

$synth4 = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth4.SetOutputToWaveFile("$PSScriptRoot\..\test_drive.wav")
$synth4.Speak("Upload my project to Drive and give me the link")
$synth4.Dispose()

Write-Host "Generated all 4 scenario WAV files successfully: test_wifi.wav, test_youtube.wav, test_claude.wav, test_drive.wav"
