import Link from "next/link";

export default function NotFound() {
  return (
    <div className="void-page">
      <p className="kicker">Lost slag</p>
      <h1 className="void-page__title">Lost slag.</h1>
      <p className="void-page__body">This page never left the crucible.</p>
      <Link className="btn btn-primary" href="/">
        Back to the forge
      </Link>
    </div>
  );
}
