import Link from "next/link";

export default function NotFound() {
  return (
    <div style={{ maxWidth: 640, margin: "120px auto", padding: "0 24px", textAlign: "center" }}>
      <p className="kicker">Lost slag</p>
      <h1 style={{ fontSize: 44, margin: "16px 0" }}>Lost slag.</h1>
      <p style={{ color: "var(--dim)" }}>This page never left the crucible.</p>
      <Link className="btn btn-primary" href="/">
        Back to the forge
      </Link>
    </div>
  );
}
