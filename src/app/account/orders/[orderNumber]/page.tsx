"use client";

import { ArrowRight, PackageCheck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense } from "react";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/auth-provider";
import { AppHeader } from "@/components/app-header";
import { graphqlRequest, ORDER_FIELDS, Order } from "@/lib/api";
import { formatPrice, statusLabel } from "@/lib/store";

const progress: Order["status"][] = [
  "REQUESTED",
  "REVIEWING",
  "AWAITING_BUYER_CONFIRMATION",
  "AWAITING_PAYMENT",
  "PAYMENT_VERIFIED",
  "READY_TO_DISPATCH",
  "DISPATCHED",
  "DELIVERED",
];

function AccountOrderDetailsContent() {
  const { orderNumber } = useParams<{ orderNumber: string }>();
  const { user, loading: sessionLoading } = useSession();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadOrder = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const result = await graphqlRequest<{ myOrder: Order | null }>(
        `query MyOrder($orderNumber: String!) { myOrder(orderNumber: $orderNumber) { ${ORDER_FIELDS} } }`,
        { orderNumber },
      );
      setOrder(result.myOrder);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This request couldn’t be loaded.");
    } finally {
      setLoading(false);
    }
  }, [orderNumber, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadOrder(), 0);
    return () => window.clearTimeout(timer);
  }, [loadOrder]);

  async function acceptTerms() {
    if (!order || !accepted) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await graphqlRequest(
        `mutation AcceptOrderTerms($orderNumber: String!) { acceptOrderTerms(orderNumber: $orderNumber) { id } }`,
        { orderNumber: order.orderNumber },
      );
      setMessage("Thank you. The agreed order is now awaiting payment arrangements with the shop.");
      await loadOrder();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your confirmation couldn’t be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (sessionLoading || loading) return <main className="account-page"><div className="app-loading">Loading your request…</div></main>;

  return (
    <main className="account-page">
      <AppHeader variant="account" />
      <div className="account-content">
        {!user ? <section className="account-empty"><h1>Sign in to see your request.</h1><p>Order details are private to the account that placed the request.</p><Link className="button button-dark" href={`/login?returnTo=${encodeURIComponent(`/account/orders/${orderNumber}`)}`}>Sign in <ArrowRight size={15} /></Link></section> : error ? <section className="account-empty"><h1>We couldn’t load this request.</h1><p className="form-message error" role="alert">{error}</p><button className="button button-dark" onClick={() => void loadOrder()}>Try again</button></section> : !order ? <section className="account-empty"><h1>Request not found.</h1><p>This request may not exist or may belong to another account.</p><Link className="button button-dark" href="/account/orders">My requests <ArrowRight size={15} /></Link></section> : <>
          <div className="account-heading"><div className="eyebrow"><span className="eyebrow-line" /> YOUR REQUEST</div><h1>{order.orderNumber}</h1><p>We’ll keep you updated as your request moves through the shop.</p></div>
          {error && <p className="form-message error" role="alert">{error}</p>}{message && <p className="form-message" role="status">{message}</p>}
          <section className="account-order-card">
            <div className="account-order-top"><div><span className="account-order-date">REQUESTED {new Date(order.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</span><h2>{statusLabel(order.status)}</h2></div><span className={`payment-pill payment-${order.paymentStatus.toLowerCase()}`}>{order.paymentStatus.replaceAll("_", " ")}</span></div>
            {order.status === "CANCELLED" ? <div className="account-cancelled"><p>This request was cancelled.{order.cancellationReason ? ` ${order.cancellationReason}` : ""} Please contact our shop if you need help.</p>{order.paymentStatus === "REFUND_PENDING" && <p>A refund follow-up is pending with the shop.</p>}</div> : <div className="order-progress" aria-label={`Order status: ${statusLabel(order.status)}`}>{progress.map((step, index) => <span key={step} className={index <= progress.indexOf(order.status) ? "progress-dot done" : "progress-dot"} title={statusLabel(step)} />)}<strong>{statusLabel(order.status)}</strong></div>}
            <h3 className="profile-section-title">Your instruments</h3>
            <div className="account-order-items">{order.items.map((item) => <div className="account-order-item" key={item.id}><span className="order-item-qty">{String(item.quantity).padStart(2, "0")}</span><span>{item.name}{item.agreedVariant ? ` · ${item.agreedVariant}` : ""}</span><strong>{item.agreedUnitPrice !== null ? formatPrice(item.quantity * item.agreedUnitPrice) : item.priceMode === "QUOTE" ? "Quote to follow" : order.termsConfirmedAt ? "Price to confirm" : "Indicative"}</strong></div>)}</div>
            <div className="account-order-total"><span>{order.finalAmount === null ? "Indicative item total" : "Confirmed order total"}</span><strong>{formatPrice(order.finalAmount ?? order.subtotal)}{order.items.some((item) => item.priceMode === "QUOTE") && order.finalAmount === null ? " +" : ""}</strong></div>
            {order.termsConfirmedAt && <section className="confirmed-terms"><h3>Final terms from the shop</h3>{order.termsMessage && <p className="terms-message">{order.termsMessage}</p>}<div className="account-order-total"><span>Items</span><strong>{formatPrice(order.subtotal)}</strong></div><div className="account-order-total"><span>Delivery</span><strong>{formatPrice(order.deliveryFee)}</strong></div>{order.discount > 0 && <div className="account-order-total"><span>Discount</span><strong>−{formatPrice(order.discount)}</strong></div>}<div className="account-order-total"><span>Total to pay</span><strong>{formatPrice(order.finalAmount ?? 0)}</strong></div>
              {order.status === "AWAITING_BUYER_CONFIRMATION" && <div className="terms-acceptance"><label><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> I’ve reviewed and agree to the item quantities, final prices and delivery charge above.</label><button className="button button-dark" disabled={!accepted || busy} onClick={() => void acceptTerms()}>{busy ? "Saving…" : "Accept final terms"} <ArrowRight size={15} /></button><p>Payment is arranged with the shop only after you accept. No payment is taken online.</p></div>}
              {order.status === "AWAITING_PAYMENT" && !order.termsBuyerAcceptedAt && <div className="terms-acceptance"><p>The shop has recorded payment details. You can still review and confirm the final terms below.</p><label><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> I’ve reviewed and agree to the item quantities, final prices and delivery charge above.</label><button className="button button-dark" disabled={!accepted || busy} onClick={() => void acceptTerms()}>{busy ? "Saving…" : "Confirm final terms"} <ArrowRight size={15} /></button></div>}
            </section>}
            <section className="account-address"><PackageCheck size={16} /><div><strong>Delivery to {order.address.recipientName}</strong><span>{order.address.line1}{order.address.line2 ? `, ${order.address.line2}` : ""}<br />{order.address.city}, {order.address.state} {order.address.postalCode}<br />{order.address.phone}</span></div></section>
            {order.shipments.map((shipment) => <section className="account-address" key={shipment.dispatchedAt}><PackageCheck size={16} /><span>{shipment.courier}{shipment.trackingNumber ? ` · Tracking ${shipment.trackingNumber}` : " · Tracking unavailable"}{shipment.deliveredAt ? " · Delivered" : ""}</span></section>)}
            <p className="order-next-step">Questions about this request? Reply to the shop using the contact details they shared with you.</p>
          </section>
        </>}
      </div>
    </main>
  );
}

export default function AccountOrderDetailsPage() {
  return <Suspense fallback={<main className="account-page"><div className="app-loading">Loading your request…</div></main>}><AccountOrderDetailsContent /></Suspense>;
}
