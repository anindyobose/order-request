"use client";

import { ArrowLeft, ArrowRight, Music2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { useSession } from "@/components/auth-provider";
import { authRequest } from "@/lib/api";

function safeReturnTo(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/account/orders";
  }
  try {
    const destination = new URL(value, window.location.origin);
    if (destination.origin !== window.location.origin) return "/account/orders";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/account/orders";
  }
}

export function AuthForm({
  mode,
  returnTo,
}: {
  mode: "login" | "register";
  returnTo: string | null;
}) {
  const router = useRouter();
  const { login, register } = useSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const registering = mode === "register";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      if (registering) {
        const email = String(form.get("email") ?? "").trim();
        const phone = String(form.get("phone") ?? "").trim();
        if (!email && !phone) {
          setError("Enter an email address or phone number so we can reach you.");
          return;
        }
        await register({
          name: String(form.get("name") ?? "").trim(),
          email,
          phone,
          password: String(form.get("password") ?? ""),
        });
      } else {
        await login(
          String(form.get("identifier") ?? "").trim(),
          String(form.get("password") ?? ""),
        );
      }
      router.replace(safeReturnTo(returnTo));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn’t complete that request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <header className="workspace-header auth-header">
        <Link href="/" className="brand">
          <span className="brand-mark"><Music2 size={20} /></span>
          <span className="brand-name">New Chandan<span>musicals</span></span>
        </Link>
        <Link href="/" className="workspace-back"><ArrowLeft size={15} /> Back to the shop</Link>
      </header>
      <section className="auth-card">
        <div className="eyebrow"><span className="eyebrow-line" /> YOUR LITTLE CORNER OF MUSIC</div>
        <h1>{registering ? <>Make yourself<br /><em>at home.</em></> : <>Welcome<br /><em>back.</em></>}</h1>
        <p className="auth-description">{registering ? "Create your account to send requests and keep up with the instruments you love." : "Sign in to follow your requests and keep your details close by."}</p>
        <form className="auth-form" onSubmit={submit}>
          {registering && (
            <label>Your name
              <input name="name" autoComplete="name" minLength={2} maxLength={100} placeholder="What should we call you?" required />
            </label>
          )}
          {registering ? (
            <>
              <label>Email address <span>(one way for us to reach you)</span>
                <input name="email" autoComplete="email" type="email" maxLength={254} placeholder="you@example.com" />
              </label>
              <label>Phone number <span>(or add your phone instead)</span>
                <input name="phone" autoComplete="tel" type="tel" maxLength={20} placeholder="+91 98765 43210" />
              </label>
            </>
          ) : (
            <label>Email or phone number
              <input name="identifier" autoComplete="username" maxLength={254} placeholder="you@example.com" required />
            </label>
          )}
          <label>Password
            <input name="password" autoComplete={registering ? "new-password" : "current-password"} type="password" minLength={registering ? 12 : undefined} maxLength={128} placeholder={registering ? "At least 12 characters" : "Your password"} required />
          </label>
          {registering && <p className="password-guidance">Use 12+ characters, with uppercase, lowercase and a number.</p>}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="button button-dark auth-submit" type="submit" disabled={busy}>
            {busy ? "One moment…" : registering ? "Create my account" : "Sign in"} <ArrowRight size={16} />
          </button>
        </form>
        {!registering && <Link className="forgot-link" href="/forgot-password">Forgot your password?</Link>}
        <div className="auth-switch">
          {registering ? <>Already have an account? <Link href={`/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}>Sign in</Link></> : <>New around here? <Link href={`/register${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}>Create an account</Link></>}
        </div>
        <p className="auth-privacy">We only use your details to help with your account and orders.</p>
      </section>
    </main>
  );
}

export function ForgotPasswordForm() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = new FormData(event.currentTarget);
      const response = await authRequest<{ message: string }>("forgot-password", {
        email: String(form.get("email") ?? "").trim(),
      });
      setMessage(response.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn’t submit that request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScaffold title={<>A way back to<br /><em>your account.</em></>} description="Enter your account email. If we find a match, we’ll send a single-use recovery link.">
      {message ? (
        <div className="auth-success" role="status">{message}</div>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <label>Email address<input name="email" type="email" autoComplete="email" maxLength={254} placeholder="you@example.com" required /></label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="button button-dark auth-submit" type="submit" disabled={busy}>{busy ? "Sending…" : "Send recovery link"} <ArrowRight size={16} /></button>
        </form>
      )}
      <Link className="auth-back-link" href="/login"><ArrowLeft size={14} /> Back to sign in</Link>
    </AuthScaffold>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirmPassword") ?? "")) {
      setError("Those passwords don’t match yet.");
      setBusy(false);
      return;
    }
    try {
      await authRequest("reset-password", { token, password });
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This recovery link can’t be used.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScaffold title={<>A new key for<br /><em>your account.</em></>} description="Choose a new password to get back to your requests.">
      {done ? (
        <div className="auth-success" role="status">Your password has been updated. You can now sign in with the new one.</div>
      ) : !token ? (
        <p className="auth-error" role="alert">This recovery link is missing or invalid. Request a new one to continue.</p>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
          <label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
          <p className="password-guidance">Use 12+ characters, with uppercase, lowercase and a number.</p>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="button button-dark auth-submit" type="submit" disabled={busy}>{busy ? "Updating…" : "Update password"} <ArrowRight size={16} /></button>
        </form>
      )}
      <Link className="auth-back-link" href="/login"><ArrowLeft size={14} /> Back to sign in</Link>
    </AuthScaffold>
  );
}

function AuthScaffold({
  title,
  description,
  children,
}: {
  title: React.ReactNode;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="auth-page">
      <header className="workspace-header auth-header">
        <Link href="/" className="brand"><span className="brand-mark"><Music2 size={20} /></span><span className="brand-name">New Chandan<span>musicals</span></span></Link>
        <Link href="/" className="workspace-back"><ArrowLeft size={15} /> Back to the shop</Link>
      </header>
      <section className="auth-card">
        <div className="eyebrow"><span className="eyebrow-line" /> YOUR LITTLE CORNER OF MUSIC</div>
        <h1>{title}</h1>
        <p className="auth-description">{description}</p>
        {children}
      </section>
    </main>
  );
}
