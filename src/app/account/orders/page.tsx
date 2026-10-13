"use client";

import {
  ArrowLeft,
  ArrowRight,
  LogOut,
  Music2,
  PackageCheck,
  ShoppingBag,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/auth-provider";
import { graphqlRequest, ORDER_FIELDS, Order } from "@/lib/api";
import { formatPrice, statusLabel } from "@/lib/store";

function OrderProgress({ status }: { status: Order["status"] }) {
  const steps: Order["status"][] = [
    "REQUESTED",
    "REVIEWING",
    "AWAITING_BUYER_CONFIRMATION",
    "AWAITING_PAYMENT",
    "PAYMENT_VERIFIED",
    "READY_TO_DISPATCH",
    "DISPATCHED",
    "DELIVERED",
  ];
  if (status === "CANCELLED") {
    return <p className="account-cancelled">This request was cancelled. Please contact our shop if you need help.</p>;
  }
  const activeIndex = steps.indexOf(status);
  return (
    <div className="order-progress" aria-label={`Order status: ${statusLabel(status)}`}>
      {steps.map((step, index) => (
        <span key={step} className={index <= activeIndex ? "progress-dot done" : "progress-dot"} title={statusLabel(step)} />
      ))}
      <strong>{statusLabel(status)}</strong>
    </div>
  );
}

export default function AccountOrdersPage() {
  const router = useRouter();
  const { user, loading: sessionLoading, error: sessionError, logout } = useSession();
  const [orders, setOrders] = useState<Order[]>([]);
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadOrders = useCallback(async () => {
    if (!user) return;
    setBusy(true);
    try {
      const data = await graphqlRequest<{
        myOrders: { items: Order[]; hasNextPage: boolean };
      }>(
        `query MyOrders($page: PageInput) {
          myOrders(page: $page) {
            items { ${ORDER_FIELDS} }
            hasNextPage
          }
        }`,
        { page: { page, pageSize: 10 } },
      );
      setOrders(data.myOrders.items);
      setHasNextPage(data.myOrders.hasNextPage);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your requests couldn’t be loaded.");
    } finally {
      setBusy(false);
    }
  }, [page, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadOrders(), 0);
    return () => window.clearTimeout(timer);
  }, [loadOrders]);

  async function signOut() {
    try {
      await logout();
      router.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn’t sign you out.");
    }
  }

  return (
    <main className="account-page">
      <header className="workspace-header">
        <Link href="/" className="brand">
          <span className="brand-mark"><Music2 size={20} /></span>
          <span className="brand-name">new chandan<span>musicals</span></span>
        </Link>
        <div className="account-header-actions">
          {user && <Link href="/account/profile" className="workspace-back"><UserRound size={14} /> My profile</Link>}
          {user && <button className="account-signout" onClick={() => void signOut()}><LogOut size={13} /> Sign out</button>}
          <Link href="/" className="workspace-back"><ArrowLeft size={15} /> Back to the shop</Link>
        </div>
      </header>
      <div className="account-content">
        <div className="account-heading">
          <div className="eyebrow"><span className="eyebrow-line" /> YOUR LITTLE COLLECTION</div>
          <h1>Your <em>requests.</em></h1>
          <p>Keep an eye on the instruments you’ve asked us about. We’ll be in touch to confirm the details.</p>
        </div>
        {sessionLoading ? (
          <div className="app-loading" role="status">Checking your account…</div>
        ) : !user ? (
          <section className="account-empty">
            <span className="account-empty-icon"><UserRound size={23} /></span>
            <h2>Your requests have a home.</h2>
            <p>Sign in to see your own requests, or create an account to get started.</p>
            {(error || sessionError) && <p className="form-message error" role="alert">{error || sessionError}</p>}
            <Link className="button button-dark" href="/login?returnTo=%2Faccount%2Forders">Sign in <ArrowRight size={15} /></Link>
            <Link className="forgot-link" href="/register?returnTo=%2Faccount%2Forders">Create an account</Link>
          </section>
        ) : error ? (
          <section className="account-empty">
            <span className="account-empty-icon"><PackageCheck size={23} /></span>
            <h2>Your requests didn’t load.</h2>
            <p className="form-message error" role="alert">{error}</p>
            <button className="button button-dark" onClick={() => void loadOrders()} disabled={busy}>Try again</button>
          </section>
        ) : orders.length ? (
          <>
            <div className="account-orders">
              {orders.map((order) => {
                const hasQuote = order.items.some((item) => item.priceMode === "QUOTE");
                const total = order.finalAmount ?? order.subtotal;
                return (
                  <article className="account-order-card" key={order.id}>
                    <div className="account-order-top">
                      <div>
                        <span className="account-order-date">
                          REQUESTED {new Date(order.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
                        </span>
                        <h2><Link href={`/account/orders/${encodeURIComponent(order.orderNumber)}`}>{order.orderNumber}</Link></h2>
                      </div>
                      <span className={`payment-pill payment-${order.paymentStatus.toLowerCase()}`}>
                        {order.paymentStatus === "NOT_DUE" ? "No payment due" : order.paymentStatus === "PENDING" ? "Payment arranged after confirmation" : order.paymentStatus === "VERIFIED" ? "Payment verified" : order.paymentStatus === "PARTIALLY_PAID" ? "Part payment verified" : order.paymentStatus === "REFUND_PENDING" ? "Refund follow-up" : "Payment updated"}
                      </span>
                    </div>
                    <div className="account-order-items">
                      {order.items.map((item) => (
                        <div key={item.id} className="account-order-item">
                          <span className="order-item-qty">{String(item.quantity).padStart(2, "0")}</span>
                          <span>{item.name}{item.agreedVariant ? ` · ${item.agreedVariant}` : ""}</span>
                          <strong>{item.agreedUnitPrice !== null ? formatPrice(item.quantity * item.agreedUnitPrice) : item.priceMode === "QUOTE" ? "Quote to follow" : order.termsConfirmedAt ? "Price to confirm" : "Indicative"}</strong>
                        </div>
                      ))}
                    </div>
                    <div className="account-order-total"><span>{order.finalAmount === null ? "Indicative item total" : "Confirmed order total"}</span><strong>{formatPrice(total)}{hasQuote && order.finalAmount === null ? " +" : ""}</strong></div>
                    <OrderProgress status={order.status} />
                    {order.status === "REQUESTED" && <p className="order-next-step">Next up: our shop team will check availability and get in touch to agree the final details.</p>}
                    {order.status === "AWAITING_BUYER_CONFIRMATION" && <p className="order-next-step">The shop has proposed final terms. <Link href={`/account/orders/${encodeURIComponent(order.orderNumber)}`}>Review and respond</Link>.</p>}
                    {order.shipments[0] && <div className="account-address"><PackageCheck size={15} /><span>{order.shipments[0].courier}{order.shipments[0].trackingNumber ? ` · Tracking ${order.shipments[0].trackingNumber}` : " · Tracking unavailable"}</span></div>}
                    {!order.shipments.length && <div className="account-address"><PackageCheck size={15} /><span>Delivery to {order.address.line1}, {order.address.city}, {order.address.state} {order.address.postalCode}</span></div>}
                  </article>
                );
              })}
            </div>
            <div className="account-pagination">
              <button className="button button-outline" disabled={page <= 1 || busy} onClick={() => setPage((current) => current - 1)}>Previous</button>
              <span>Page {page}</span>
              <button className="button button-outline" disabled={!hasNextPage || busy} onClick={() => setPage((current) => current + 1)}>Next</button>
            </div>
          </>
        ) : (
          <section className="account-empty">
            <span className="account-empty-icon"><ShoppingBag size={23} /></span>
            <h2>Nothing in the works. Yet.</h2>
            <p>When you send us a request for an instrument, you’ll find it waiting here.</p>
            <Link className="button button-dark" href="/#shop">Find your sound <ArrowRight size={15} /></Link>
          </section>
        )}
        {user && <div className="account-help">Have a question about a request? <Link href="/#visit">Our friendly team is happy to help.</Link></div>}
      </div>
      <footer className="workspace-footer">New Chandan Musicals <span>·</span> Good things happen in harmony.</footer>
    </main>
  );
}
