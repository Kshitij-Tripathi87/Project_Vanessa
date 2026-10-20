Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToWaveFile("$PSScriptRoot\..\test_wifi.wav")
$synth.Speak("Hey Vanessa, restart my Wi-Fi")
$synth.Dispose()

$synth2 = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth2.SetOutputToWaveFile("$PSScriptRoot\..\test_youtube.wav")
$synth2.Speak("Turn on Bluetooth and play lofi on YouTube")
$synth2.Dispose()

Write-Host "Generated test_wifi.wav and test_youtube.wav successfully"
