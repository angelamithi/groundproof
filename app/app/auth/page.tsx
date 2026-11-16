// Google redirects the sign-in popup here; the Enoki wallet in the main window
// reads the result and closes the popup. Register this URL in Google Cloud and Enoki.
export default function AuthCallback() {
  return <p className="center muted">Signing you in…</p>;
}
