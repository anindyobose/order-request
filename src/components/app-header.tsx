"use client";

import { ArrowLeft, LayoutDashboard, LogOut, Menu, Music2, Package, Settings, ShieldCheck, ShoppingBag, Users, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSession } from "@/components/auth-provider";

type AppHeaderProps =
  | { variant: "storefront"; itemCount?: number; onOpenBag?: () => void; compact?: boolean }
  | { variant: "account" | "admin" };

export function AppHeader(props: AppHeaderProps) {
  const router = useRouter();
  const { user, logout } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const isAdmin = user?.role === "ADMIN";
  const isStaff = user?.role === "ADMIN" || user?.role === "ORDER_OPERATOR";

  async function signOut() {
    setSignOutError("");
    try {
      await logout();
      setMenuOpen(false);
      router.replace("/");
    } catch (cause) {
      setSignOutError(cause instanceof Error ? cause.message : "We couldn’t sign you out.");
    }
  }

  const brand = (
    <Link href="/" className="brand" aria-label="New Chandan Musicals home">
      <span className="brand-mark"><Music2 size={20} /></span>
      <span className="brand-name">New Chandan<span>musicals</span></span>
    </Link>
  );

  if (props.variant === "storefront") {
    const { itemCount = 0, onOpenBag, compact = false } = props;
    return (
      <header className="site-header">
        {brand}
        <nav className={`main-nav ${menuOpen ? "is-open" : ""}`} aria-label="Main navigation">
          {compact ? <Link href="/#shop" onClick={() => setMenuOpen(false)}>Shop all</Link> : <>
            <a href="#shop" onClick={() => setMenuOpen(false)}>Shop all</a>
            <a href="#collections" onClick={() => setMenuOpen(false)}>Collections</a>
            <a href="#our-story" onClick={() => setMenuOpen(false)}>Our story</a>
            <a href="#visit" onClick={() => setMenuOpen(false)}>Visit us</a>
          </>}
          <Link className="mobile-account-link" href={user ? "/account/orders" : "/login"}>{user ? "My requests" : "Sign in"}</Link>
          {isStaff && <Link className="mobile-dashboard-link" href="/admin">Shop dashboard</Link>}
          {user && <button className="mobile-signout-link" onClick={() => void signOut()}>Sign out</button>}
        </nav>
        <div className="header-actions">
          <Link className="account-link" href={user ? "/account/orders" : "/login"}>{user ? "My requests" : "Sign in"}</Link>
          {isStaff && <Link className="account-link admin-header-link" href="/admin">Shop dashboard</Link>}
          {user && <button className="home-signout-link" onClick={() => void signOut()}><LogOut size={13} /> Sign out</button>}
          {onOpenBag && <button className="icon-button bag-button" onClick={onOpenBag} aria-label={`Open request bag, ${itemCount} items`}>
            <ShoppingBag size={19} />
            <span className="bag-count">{itemCount}</span>
          </button>}
          <button className="icon-button menu-button" onClick={() => setMenuOpen((open) => !open)} aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen}>
            {menuOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
        {signOutError && <span className="header-auth-error" role="alert">{signOutError}</span>}
      </header>
    );
  }

  const isAdminHeader = props.variant === "admin";
  return (
    <header className={isAdminHeader ? "admin-topbar app-workspace-header" : "workspace-header app-workspace-header"}>
      {brand}
      <nav className={isAdminHeader ? "admin-topbar-right" : "account-header-actions"} aria-label={isAdminHeader ? "Admin navigation" : "Account navigation"}>
        {isAdminHeader ? <>
          <Link href="/admin" className="workspace-back"><LayoutDashboard size={14} /> Orders</Link>
          {isAdmin && <Link href="/admin/products" className="workspace-back"><Package size={14} /> Products</Link>}
          {isAdmin && <Link href="/admin/users" className="workspace-back"><Users size={14} /> User access</Link>}
          {isAdmin && <Link href="/admin/settings" className="workspace-back"><Settings size={14} /> Settings</Link>}
          <Link href="/" className="workspace-back"><ArrowLeft size={14} /> Storefront</Link>
        </> : <>
          {user ? <>
            <Link href="/account/orders" className="workspace-back">My requests</Link>
            <Link href="/account/profile" className="workspace-back"><ShieldCheck size={14} /> My profile</Link>
          </> : <Link href="/login" className="workspace-back">Sign in</Link>}
          <Link href="/" className="workspace-back"><ArrowLeft size={14} /> Shop</Link>
        </>}
        {user ? <button className="account-signout" onClick={() => void signOut()}><LogOut size={13} /> Sign out</button> : isAdminHeader ? <Link href="/login" className="workspace-back">Sign in</Link> : null}
      </nav>
      {signOutError && <span className="header-auth-error" role="alert">{signOutError}</span>}
    </header>
  );
}
