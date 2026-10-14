"use client";

import { RefreshCw, Save } from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/auth-provider";
import { AppHeader } from "@/components/app-header";
import { graphqlRequest } from "@/lib/api";

type Settings = {
  adminRecipients: string[];
  newOrderEmailEnabled: boolean;
  buyerDispatchSmsEnabled: boolean;
  emailConfigured: boolean;
  smsConfigured: boolean;
};

type Job = {
  id: string;
  orderNumber: string | null;
  eventType: string;
  channel: "EMAIL" | "SMS";
  recipient: string;
  status: "PENDING" | "PROCESSING" | "SENT" | "RETRY" | "FAILED";
  attempts: number;
  nextAttemptAt: string;
  sentAt: string | null;
  lastError: string | null;
  createdAt: string;
};

type Health = { status: string; database: string; notificationWorker: string };
const SETTINGS_FIELDS = "adminRecipients newOrderEmailEnabled buyerDispatchSmsEnabled emailConfigured smsConfigured";

export default function AdminSettingsPage() {
  const { user, loading } = useSession();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsPage, setJobsPage] = useState(1);
  const [health, setHealth] = useState<Health | null>(null);
  const [recipientsText, setRecipientsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadSettings = useCallback(async () => {
    if (user?.role !== "ADMIN") return;
    setError("");
    try {
      const [result, notifications, healthResponse] = await Promise.all([
        graphqlRequest<{ notificationSettings: Settings }>(`query NotificationSettings { notificationSettings { ${SETTINGS_FIELDS} } }`),
        graphqlRequest<{ notificationJobs: Job[] }>(`
          query FailedNotifications($status: NotificationStatus, $page: PageInput) {
            notificationJobs(status: $status, page: $page) {
              id orderNumber eventType channel recipient status attempts nextAttemptAt sentAt lastError createdAt
            }
          }
        `, { status: "FAILED", page: { page: jobsPage, pageSize: 50 } }),
        fetch("/api/health", { cache: "no-store" }),
      ]);
      setSettings(result.notificationSettings);
      setRecipientsText(result.notificationSettings.adminRecipients.join(", "));
      setJobs(notifications.notificationJobs);
      const healthBody = await healthResponse.json() as Health;
      setHealth(healthBody);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Settings and notification status couldn’t be loaded.");
    }
  }, [jobsPage, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSettings(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSettings]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const adminRecipients = recipientsText.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean);
      const input = {
        adminRecipients,
        newOrderEmailEnabled: settings.newOrderEmailEnabled,
        buyerDispatchSmsEnabled: settings.buyerDispatchSmsEnabled,
      };
      await graphqlRequest(
        `mutation UpdateNotificationSettings($input: NotificationSettingsInput!) { updateNotificationSettings(input: $input) { ${SETTINGS_FIELDS} } }`,
        { input },
      );
      setMessage("Notification preferences saved. Delivery still requires a configured provider and running worker.");
      await loadSettings();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Notification preferences couldn’t be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function retry(jobId: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await graphqlRequest(
        "mutation RetryNotification($notificationJobId: ID!) { retryNotification(notificationJobId: $notificationJobId) { id } }",
        { notificationJobId: jobId },
      );
      setMessage("Notification queued for another delivery attempt.");
      await loadSettings();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Notification couldn’t be retried.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="admin-page"><div className="app-loading">Checking administrator access…</div></main>;
  if (!user || user.role !== "ADMIN") return <main className="admin-page"><div className="admin-content"><section className="account-empty"><h1>Administrator access required.</h1><Link className="button button-dark" href="/login?returnTo=%2Fadmin%2Fsettings">Sign in</Link></section></div></main>;

  return (
    <main className="admin-page">
      <AppHeader variant="admin" />
      <div className="admin-content">
        <div className="admin-page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> SHOP OPERATIONS</div><h1>Settings & <em>notices.</em></h1><p>Configure notification preferences and monitor their delivery status.</p></div></div>
        {error && <p className="form-message error" role="alert">{error}</p>}{message && <p className="form-message" role="status">{message}</p>}
        <section className="admin-orders-section">
          <div className="admin-orders-heading"><div><h2>Service health</h2><p>Delivery requires PostgreSQL, the worker process and configured provider credentials.</p></div><button className="profile-add-button" onClick={() => void loadSettings()}><RefreshCw size={14} /> Refresh</button></div>
          <div className="service-health-grid">
            <HealthValue label="DATABASE" value={health?.database ?? "checking"} />
            <HealthValue label="NOTIFICATION WORKER" value={health?.notificationWorker ?? "checking"} />
            <HealthValue label="EMAIL PROVIDER" value={settings?.emailConfigured ? "configured" : "not configured"} />
            <HealthValue label="SMS PROVIDER" value={settings?.smsConfigured ? "configured" : "not configured"} />
          </div>
        </section>
        {settings &&         <section className="admin-orders-section">
          <h2 className="profile-section-title">Notification preferences</h2>
          <form className="request-form notification-settings-form" onSubmit={(event) => void saveSettings(event)}>
            <p className="account-help">Buyer status-update emails are queued for every request status change and cannot be disabled here. Delivery depends on the configured email provider and worker health.</p>
            <label>Administrator email recipients <span>Separate up to 20 addresses with commas or spaces.</span><textarea rows={3} value={recipientsText} onChange={(event) => setRecipientsText(event.target.value)} placeholder="shop@example.com" /></label>
            <Toggle label="Email administrators when a new order is submitted" checked={settings.newOrderEmailEnabled} onChange={(value) => setSettings({ ...settings, newOrderEmailEnabled: value })} />
            <Toggle label="SMS buyers when orders are dispatched" checked={settings.buyerDispatchSmsEnabled} onChange={(value) => setSettings({ ...settings, buyerDispatchSmsEnabled: value })} />
            <p className="password-guidance">Provider secrets are environment configuration, not stored in this settings form. No provider is simulated.</p>
            <button className="button button-dark" disabled={busy}><Save size={15} /> Save preferences</button>
          </form>
        </section>}
        <section className="admin-orders-section">
          <div className="admin-orders-heading"><div><h2>Failed notifications</h2><p>Failed delivery attempts are retained for inspection and manual retry.</p></div><span>{jobs.length} shown</span></div>
          {jobs.length ? <><div className="notification-job-list">{jobs.map((job) => <article className="notification-job" key={job.id}><div><strong>{job.eventType.replaceAll("_", " ")} · {job.channel}</strong><span>{job.orderNumber ?? "No order"} · {job.recipient}</span><span>Attempts: {job.attempts} · Created {new Date(job.createdAt).toLocaleString()}</span>{job.lastError && <p role="alert">{job.lastError}</p>}</div><button className="button button-outline" disabled={busy} onClick={() => void retry(job.id)}>Retry</button></article>)}</div><div className="catalog-pagination"><button className="button button-outline" disabled={jobsPage <= 1 || busy} onClick={() => setJobsPage((value) => value - 1)}>Previous</button><span>Page {jobsPage}</span><button className="button button-outline" disabled={jobs.length < 50 || busy} onClick={() => setJobsPage((value) => value + 1)}>Next</button></div></> : <p className="account-help">No failed notifications on this page.</p>}
        </section>
      </div>
    </main>
  );
}

function HealthValue({ label, value }: { label: string; value: string }) {
  return <div className="health-value"><span>{label}</span><strong className={value === "ok" || value === "configured" ? "health-ok" : "health-warning"}>{value}</strong></div>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="settings-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}
