"use client";

import { Search, ShieldCheck, ShieldOff } from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/auth-provider";
import { AppHeader } from "@/components/app-header";
import { graphqlRequest, SessionUser } from "@/lib/api";

type ManagedUser = Pick<SessionUser, "id" | "name" | "email" | "phone" | "role"> & {
  status: "ACTIVE" | "DISABLED";
};

export default function AdminUsersPage() {
  const { user, loading } = useSession();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [busyUserId, setBusyUserId] = useState("");
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadUsers = useCallback(async () => {
    if (user?.role !== "ADMIN") return;
    setLoadingUsers(true);
    setError("");
    try {
      const result = await graphqlRequest<{ adminUsers: ManagedUser[] }>(
        `query AdminUsers($search: String) {
          adminUsers(search: $search) { id name email phone role status }
        }`,
        { search: submittedSearch || undefined },
      );
      setUsers(result.adminUsers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Users could not be loaded.");
    } finally {
      setLoadingUsers(false);
    }
  }, [submittedSearch, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadUsers(), 0);
    return () => window.clearTimeout(timer);
  }, [loadUsers]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = search.trim();
    if (normalized && normalized.length < 2) {
      setError("Enter at least two characters to search.");
      return;
    }
    setError("");
    setSubmittedSearch(normalized);
  }

  async function changeRole(target: ManagedUser) {
    const role = target.role === "ADMIN" ? "ORDER_OPERATOR" : "ADMIN";
    const action = role === "ADMIN" ? "grant administrator access to" : "revoke administrator access from";
    if (!window.confirm(`Are you sure you want to ${action} ${target.name}?`)) return;

    setBusyUserId(target.id);
    setError("");
    setMessage("");
    try {
      await graphqlRequest<{ setUserRole: ManagedUser }>(
        `mutation SetUserRole($userId: ID!, $role: Role!) {
          setUserRole(userId: $userId, role: $role) { id }
        }`,
        { userId: target.id, role },
      );
      setMessage(
        role === "ADMIN"
          ? `${target.name} now has administrator access.`
          : `${target.name}'s administrator access was revoked. They remain an order operator.`,
      );
      await loadUsers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The user's access could not be changed.");
    } finally {
      setBusyUserId("");
    }
  }

  if (loading) return <main className="admin-page"><div className="app-loading">Checking administrator access…</div></main>;
  if (!user || user.role !== "ADMIN") {
    return <main className="admin-page"><div className="admin-content"><section className="account-empty"><h1>Administrator access required.</h1><Link className="button button-dark" href="/login?returnTo=%2Fadmin%2Fusers">Sign in</Link></section></div></main>;
  }

  return (
    <main className="admin-page">
      <AppHeader variant="admin" />
      <div className="admin-content">
        <div className="admin-page-heading">
          <div><div className="eyebrow"><span className="eyebrow-line" /> SHOP ACCESS</div><h1>People &amp; <em>permissions.</em></h1><p>Grant administrator access or revoke it while keeping the person as an order operator.</p></div>
        </div>
        {error && <p className="form-message error" role="alert">{error}</p>}
        {message && <p className="form-message" role="status">{message}</p>}
        <section className="admin-orders-section">
          <div className="admin-orders-heading">
            <div><h2>Manage user access</h2><p>Only administrators can change access. You cannot revoke your own access or demote the last administrator.</p></div>
          </div>
          <form className="admin-user-search" onSubmit={submitSearch}>
            <label className="admin-search"><Search size={16} /><input value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name, email or phone" aria-label="Search users" /></label>
            <button className="button button-outline" disabled={loadingUsers}>Search users</button>
          </form>
          {loadingUsers ? <div className="app-loading">Loading users…</div> : users.length ? (
            <div className="admin-user-list">
              {users.map((managedUser) => (
                <article className="admin-user-row" key={managedUser.id}>
                  <div className="admin-user-information">
                    <strong>{managedUser.name}{managedUser.id === user.id ? " (you)" : ""}</strong>
                    <span>{managedUser.email ?? managedUser.phone ?? "No contact details"}</span>
                    <small>{managedUser.role.replaceAll("_", " ")} · {managedUser.status.toLowerCase()}</small>
                  </div>
                  {managedUser.id !== user.id && <button
                    className={managedUser.role === "ADMIN" ? "button button-outline" : "button button-dark"}
                    disabled={busyUserId !== "" || managedUser.status !== "ACTIVE"}
                    onClick={() => void changeRole(managedUser)}
                  >
                    {managedUser.role === "ADMIN" ? <><ShieldOff size={15} /> Revoke admin</> : <><ShieldCheck size={15} /> Make admin</>}
                  </button>}
                </article>
              ))}
            </div>
          ) : <div className="admin-list-empty"><strong>No users found.</strong><span>Try another name, email address or phone number.</span></div>}
          <p className="account-help">Showing at most 50 users. Search for a specific name, email, or phone to find other accounts.</p>
        </section>
      </div>
    </main>
  );
}
