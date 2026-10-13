"use client";

import { ArrowLeft, ArrowRight, LogOut, Music2, Plus, Star, Trash2, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/auth-provider";
import { Address, graphqlRequest } from "@/lib/api";

const ADDRESS_FIELDS = "id recipientName phone line1 line2 city state postalCode isDefault createdAt updatedAt";

export default function AccountProfilePage() {
  const router = useRouter();
  const { user, loading, error: sessionError, reload, logout } = useSession();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [address, setAddress] = useState<Address | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [addressBusy, setAddressBusy] = useState(false);
  const [profile, setProfile] = useState({ name: "", email: "", phone: "" });

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(
      () => setProfile({ name: user.name, email: user.email ?? "", phone: user.phone ?? "" }),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [user]);

  const loadAddresses = useCallback(async () => {
    if (!user) return;
    try {
      const response = await graphqlRequest<{ myAddresses: Address[] }>(`
        query MyAddresses { myAddresses { ${ADDRESS_FIELDS} } }
      `);
      setAddresses(response.myAddresses);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your saved addresses couldn’t be loaded.");
    }
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAddresses(), 0);
    return () => window.clearTimeout(timer);
  }, [loadAddresses]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileBusy(true);
    setError("");
    setMessage("");
    try {
      await graphqlRequest(`mutation UpdateMyProfile($name: String!, $email: String, $phone: String) {
        updateMyProfile(name: $name, email: $email, phone: $phone) { id }
      }`, {
        name: profile.name.trim(),
        email: profile.email.trim() || null,
        phone: profile.phone.trim() || null,
      });
      setMessage("Your details have been saved.");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your details couldn’t be saved.");
    } finally {
      setProfileBusy(false);
    }
  }

  async function saveDeliveryAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddressBusy(true);
    setError("");
    setMessage("");
    const form = new FormData(event.currentTarget);
    const input = {
      recipientName: String(form.get("recipientName") ?? "").trim(),
      phone: String(form.get("phone") ?? "").trim(),
      line1: String(form.get("line1") ?? "").trim(),
      line2: String(form.get("line2") ?? "").trim() || null,
      city: String(form.get("city") ?? "").trim(),
      state: String(form.get("state") ?? "").trim(),
      postalCode: String(form.get("postalCode") ?? "").trim(),
      isDefault: form.get("isDefault") === "on",
    };
    try {
      if (address) {
        await graphqlRequest(`mutation UpdateAddress($addressId: ID!, $input: AddressUpdateInput!) {
          updateAddress(addressId: $addressId, input: $input) { id }
        }`, { addressId: address.id, input });
      } else {
        await graphqlRequest(`mutation SaveAddress($input: AddressInput!) {
          saveAddress(input: $input) { id }
        }`, { input });
      }
      setAddress(null);
      setMessage(address ? "Your address has been updated." : "Your new address has been saved.");
      await loadAddresses();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your address couldn’t be saved.");
    } finally {
      setAddressBusy(false);
    }
  }

  async function updateDefault(addressId: string) {
    setError("");
    try {
      await graphqlRequest(`mutation SetDefaultAddress($addressId: ID!) {
        setDefaultAddress(addressId: $addressId) { id }
      }`, { addressId });
      await loadAddresses();
      setMessage("Your default delivery address has been updated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The default address couldn’t be changed.");
    }
  }

  async function removeAddress(addressId: string) {
    if (!window.confirm("Remove this saved address? Previous orders will keep their delivery details.")) return;
    setError("");
    try {
      await graphqlRequest(`mutation DeleteAddress($addressId: ID!) {
        deleteAddress(addressId: $addressId)
      }`, { addressId });
      await loadAddresses();
      setMessage("The saved address has been removed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The address couldn’t be removed.");
    }
  }

  async function signOut() {
    try {
      await logout();
      router.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn’t sign you out.");
    }
  }

  if (loading) return <main className="account-page"><div className="app-loading">Checking your account…</div></main>;
  if (!user) {
    return <main className="account-page"><div className="account-content"><section className="account-empty"><span className="account-empty-icon"><UserRound size={23} /></span><h2>Sign in to your account.</h2><p>{sessionError || "Your profile and saved delivery addresses are private to you."}</p><Link className="button button-dark" href="/login?returnTo=%2Faccount%2Fprofile">Sign in <ArrowRight size={15} /></Link></section></div></main>;
  }

  return (
    <main className="account-page">
      <header className="workspace-header">
        <Link href="/" className="brand"><span className="brand-mark"><Music2 size={20} /></span><span className="brand-name">new chandan<span>musicals</span></span></Link>
        <div className="account-header-actions"><Link href="/account/orders" className="workspace-back"><ArrowLeft size={15} /> My requests</Link><button className="account-signout" onClick={() => void signOut()}><LogOut size={13} /> Sign out</button></div>
      </header>
      <div className="account-content">
        <div className="account-heading"><div className="eyebrow"><span className="eyebrow-line" /> YOUR ACCOUNT</div><h1>Your <em>details.</em></h1><p>Just the details that help us look after your orders.</p></div>
        {error && <p className="form-message error" role="alert">{error}</p>}
        {message && <p className="form-message" role="status">{message}</p>}
        <section className="account-order-card">
          <h2 className="profile-section-title">A little about you</h2>
          <form className="request-form" onSubmit={saveProfile}>
            <label>Your name<input value={profile.name} onChange={(event) => setProfile((current) => ({ ...current, name: event.target.value }))} minLength={2} maxLength={100} required /></label>
            <div className="form-row">
              <label>Email address<input type="email" value={profile.email} onChange={(event) => setProfile((current) => ({ ...current, email: event.target.value }))} maxLength={254} /></label>
              <label>Phone number<input type="tel" value={profile.phone} onChange={(event) => setProfile((current) => ({ ...current, phone: event.target.value }))} maxLength={20} /></label>
            </div>
            <p className="password-guidance">Keep at least one email address or phone number on your account.</p>
            <button className="button button-dark" type="submit" disabled={profileBusy}>{profileBusy ? "Saving…" : "Save my details"} <ArrowRight size={15} /></button>
          </form>
        </section>

        <div className="profile-address-heading"><h2 className="profile-section-title">Delivery addresses</h2><button className="profile-add-button" onClick={() => setAddress({ id: "", recipientName: user.name, phone: user.phone ?? "", line1: "", line2: "", city: "", state: "", postalCode: "", isDefault: !addresses.length })}><Plus size={15} /> Add an address</button></div>
        {addresses.length ? addresses.map((item) => (
          <article className="profile-address" key={item.id}>
            <div><strong>{item.recipientName} {item.isDefault && <span className="default-chip"><Star size={10} /> Default</span>}</strong><p>{item.phone}<br />{item.line1}{item.line2 ? `, ${item.line2}` : ""}, {item.city}, {item.state} {item.postalCode}</p></div>
            <div className="profile-address-actions">
              {!item.isDefault && <button onClick={() => void updateDefault(item.id)}>Set default</button>}
              <button onClick={() => setAddress(item)}>Edit</button>
              <button className="profile-delete-button" onClick={() => void removeAddress(item.id)} aria-label={`Remove address for ${item.recipientName}`}><Trash2 size={13} /></button>
            </div>
          </article>
        )) : <section className="account-empty profile-no-address"><h2>No saved addresses yet.</h2><p>Add an address to make your next request a little easier.</p></section>}

        {address && (
          <section className="profile-add-address">
            <h2 className="profile-section-title">{address.id ? "Edit this address" : "Add a delivery address"}</h2>
            <form className="request-form" onSubmit={saveDeliveryAddress}>
              <div className="form-row"><label>Recipient name<input name="recipientName" defaultValue={address.recipientName} maxLength={100} required /></label><label>Contact phone<input name="phone" type="tel" defaultValue={address.phone} maxLength={20} required /></label></div>
              <label>Address line 1<input name="line1" defaultValue={address.line1} maxLength={200} required /></label>
              <label>Address line 2<input name="line2" defaultValue={address.line2 ?? ""} maxLength={200} /></label>
              <div className="form-row"><label>City<input name="city" defaultValue={address.city} maxLength={100} required /></label><label>State<input name="state" defaultValue={address.state} maxLength={100} required /></label></div>
              <div className="form-row"><label>PIN code<input name="postalCode" defaultValue={address.postalCode} maxLength={20} required /></label><label className="default-checkbox"><input name="isDefault" type="checkbox" defaultChecked={address.isDefault} /> Make this my default</label></div>
              <div className="profile-address-actions"><button className="button button-dark" type="submit" disabled={addressBusy}>{addressBusy ? "Saving…" : "Save address"}</button><button type="button" onClick={() => setAddress(null)}>Cancel</button></div>
            </form>
          </section>
        )}
      </div>
      <footer className="workspace-footer">New Chandan Musicals <span>·</span> Your details stay yours.</footer>
    </main>
  );
}
