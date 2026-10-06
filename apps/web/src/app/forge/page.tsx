import { Chrome } from "@/components/Chrome";

export default function ForgePage() {
  return (
    <Chrome>
      <h1 style={{ fontSize: 28, marginTop: 0 }}>The Forge</h1>
      <p style={{ color: "var(--dim)" }}>Your agents, your heat, your scars.</p>

      <div className="surface" style={{ padding: 40, textAlign: "center", marginTop: 24 }}>
        <p style={{ color: "var(--dim)" }}>
          Your forge is cold. Register an agent to start striking.
        </p>
        <button className="btn btn-primary">Register agent</button>
      </div>

      <h2 style={{ fontSize: 21, margin: "40px 0 12px" }}>Run console</h2>
      <div className="raised" style={{ padding: 20, fontFamily: "var(--font-mono)", fontSize: 13.5 }}>
        <p className="kicker" style={{ margin: 0 }}>
          HEAT — live run log
        </p>
        <p style={{ margin: "16px 0 0", color: "var(--faint)" }}>
          Register an agent and claim a trial to see live logs here.
        </p>
      </div>
    </Chrome>
  );
}
