Add-Type -AssemblyName System.Speech
$ErrorActionPreference = "Stop"
$dir = "C:\Users\HP\Desktop\crucible\docs\media\narration"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# The demo's narration, one file per beat, in the order the captions appear.
$demo = @(
  @{ f = "demo-01.wav"; v = "Microsoft David Desktop"; t = "Crucible. A proving ground for AI agents, where every verdict is on chain." },
  @{ f = "demo-02.wav"; v = "Microsoft David Desktop"; t = "Six acts, one screen each: the contract's own sequence. Escrow, claim, run, challenge, verdict, reputation." },
  @{ f = "demo-03.wav"; v = "Microsoft David Desktop"; t = "An agent stakes a bond to claim a trial, and signs what it built." },
  @{ f = "demo-04.wav"; v = "Microsoft David Desktop"; t = "For the length of the skeptic window, anyone may stake against the claim." },
  @{ f = "demo-05.wav"; v = "Microsoft David Desktop"; t = "Alloy, the reputation, mints only from outcomes that survived." },
  @{ f = "demo-06.wav"; v = "Microsoft David Desktop"; t = "Trials: every row is a real trial on chain." },
  @{ f = "demo-07.wav"; v = "Microsoft David Desktop"; t = "Each trial carries its spec, its runs, its breaks, and its verdict, quoted from the chain." },
  @{ f = "demo-08.wav"; v = "Microsoft David Desktop"; t = "The Hall of Alloy: every row cites the settlement transaction that earned it." },
  @{ f = "demo-09.wav"; v = "Microsoft David Desktop"; t = "The Break: paid, staked skepticism." },
  @{ f = "demo-10.wav"; v = "Microsoft David Desktop"; t = "The Forge: register an agent, sign with your wallet." },
  @{ f = "demo-11.wav"; v = "Microsoft David Desktop"; t = "And the docs: the rules, in the open." },
  @{ f = "demo-12.wav"; v = "Microsoft David Desktop"; t = "Live at crucible dot svalley dot tech." }
)

$pitch = @(
  @{ f = "pitch-01.wav"; v = "Microsoft Zira Desktop"; t = "I'm Otema Andrew. I build systems where the trust is mechanical, not promised." },
  @{ f = "pitch-02.wav"; v = "Microsoft Zira Desktop"; t = "The problem: demos are not proof. Hiring an agent means trusting a claim you cannot test." },
  @{ f = "pitch-03.wav"; v = "Microsoft Zira Desktop"; t = "Crucible is a proving ground. Sponsors escrow a bounty and pin a test suite. Agents stake bonds and sign their work. Paid skeptics attack the claim." },
  @{ f = "pitch-04.wav"; v = "Microsoft Zira Desktop"; t = "The mechanism: a break that lands takes the bond. A run that survives pays the agent and mints Alloy. And disputes settle by commit-reveal, two of three seats." },
  @{ f = "pitch-05.wav"; v = "Microsoft Zira Desktop"; t = "Why me: nine hundred forty-six tests, a real agent loop against a real model in a real sandbox, and a live chain, live API, and live app, from one command." },
  @{ f = "pitch-06.wav"; v = "Microsoft Zira Desktop"; t = "What's next: human verification is a billion-dollar line item. Crucible reprices it with escrow and instant payout." },
  @{ f = "pitch-07.wav"; v = "Microsoft Zira Desktop"; t = "Trust is earned under heat. Crucible dot svalley dot tech." }
)

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = -0.5   # a beat slower than default; it is a recording, not a radio ad
foreach ($line in ($demo + $pitch)) {
  $synth.SelectVoice($line.v)
  $out = Join-Path $dir $line.f
  $synth.SetOutputToWaveFile($out)
  $synth.Speak($line.t)
  $synth.SetOutputToNull()
  Write-Output "wrote $($line.f)"
}
$synth.Dispose()
Write-Output "done"
