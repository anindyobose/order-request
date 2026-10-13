"use client";

import {
  ArrowLeft,
  Check,
  CircleAlert,
  Clock3,
  CreditCard,
  LogOut,
  Music2,
  PackageCheck,
  Search,
  Truck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/auth-provider";
import { graphqlRequest, ORDER_FIELDS, Order, OrderStatus } from "@/lib/api";
import { formatPrice, statusLabel } from "@/lib/store";

type Dashboard = {
  requested: number;
  reviewing: number;
  awaitingBuyerConfirmation: number;
  awaitingPayment: number;
  paymentVerified: number;
  readyToDispatch: number;
  dispatched: number;
  delivered: number;
  cancelled: number;
};

type OrderEvent = {
  id: string;
  action: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  metadata: unknown;
  actorName: string | null;
  createdAt: string;
};

type OrderConnection = { items: Order[]; total: number; hasNextPage: boolean };

const statuses: OrderStatus[] = [
  "REQUESTED",
  "REVIEWING",
  "AWAITING_BUYER_CONFIRMATION",
  "AWAITING_PAYMENT",
  "PAYMENT_VERIFIED",
  "READY_TO_DISPATCH",
  "DISPATCHED",
  "DELIVERED",
  "CANCELLED",
];

const amount = (value: FormDataEntryValue | null) => Number(String(value ?? "").trim());

export default function AdminPage() {
  const router = useRouter();
  const { user, loading: sessionLoading, logout } = useSession();
  const [orders, setOrders] = useState<Order[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [events, setEvents] = useState<OrderEvent[]>([]);
  const [selectedNumber, setSelectedNumber] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const selected = orders.find((order) => order.orderNumber === selectedNumber) ?? null;

  const loadData = useCallback(async () => {
    if (!user || !["ADMIN", "ORDER_OPERATOR"].includes(user.role)) return;
    setBusy(true);
    setError("");
    try {
      const filter = {
        status: status || undefined,
        search: search.trim() || undefined,
        fromDate: fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : undefined,
        toDate: toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : undefined,
      };
      const [queue, summary] = await Promise.all([
        graphqlRequest<{ adminOrders: OrderConnection }>(
          `query AdminOrders($filter: AdminOrderFilter, $page: PageInput) {
            adminOrders(filter: $filter, page: $page) {
              items { ${ORDER_FIELDS} internalNotes paymentRecords { id amount method reference verifiedAt createdAt } }
              total hasNextPage
            }
          }`,
          { filter, page: { page, pageSize: 20 } },
        ),
        graphqlRequest<{ dashboardSummary: Dashboard }>(
          "query DashboardSummary { dashboardSummary { requested reviewing awaitingBuyerConfirmation awaitingPayment paymentVerified readyToDispatch dispatched delivered cancelled } }",
        ),
      ]);
      setOrders(queue.adminOrders.items);
      setTotal(queue.adminOrders.total);
      setHasNextPage(queue.adminOrders.hasNextPage);
      setDashboard(summary.dashboardSummary);
      setSelectedNumber((current) =>
        queue.adminOrders.items.some((order) => order.orderNumber === current)
          ? current
          : queue.adminOrders.items[0]?.orderNumber ?? "",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The shop workspace couldn’t load.");
    } finally {
      setBusy(false);
    }
  }, [fromDate, page, search, status, toDate, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadData(), 250);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  const loadEvents = useCallback(async (orderNumber: string) => {
    if (!orderNumber) {
      setEvents([]);
      return;
    }
    try {
      const result = await graphqlRequest<{ orderEvents: OrderEvent[] }>(
        "query OrderEvents($orderNumber: String!) { orderEvents(orderNumber: $orderNumber) { id action fromStatus toStatus metadata actorName createdAt } }",
        { orderNumber },
      );
      setEvents(result.orderEvents);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The order history couldn’t load.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadEvents(selectedNumber), 0);
    return () => window.clearTimeout(timer);
  }, [loadEvents, selectedNumber]);

  async function mutate(query: string, variables: Record<string, unknown>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await graphqlRequest(query, variables);
      setMessage(success);
      await loadData();
      await loadEvents(selectedNumber);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That update couldn’t be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function saveNotes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const notes = String(new FormData(event.currentTarget).get("notes") ?? "");
    await mutate(
      "mutation AddCallNotes($orderNumber: String!, $notes: String!) { addCallNotes(orderNumber: $orderNumber, notes: $notes) { id } }",
      { orderNumber: selected.orderNumber, notes },
      "Call notes saved.",
    );
  }

  async function confirmTerms(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const items = selected.items.map((item) => ({
      orderItemId: item.id,
      quantity: amount(form.get(`quantity-${item.id}`)),
      agreedUnitPrice: amount(form.get(`price-${item.id}`)),
      agreedVariant: String(form.get(`variant-${item.id}`) ?? "").trim() || null,
    }));
    await mutate(
      `mutation ConfirmOrderTerms($input: OrderTermsInput!) {
        confirmOrderTerms(input: $input) { id }
      }`,
      {
        input: {
          orderNumber: selected.orderNumber,
          items,
          deliveryFee: amount(form.get("deliveryFee")),
          discount: amount(form.get("discount")),
          buyerMessage: String(form.get("buyerMessage") ?? "").trim() || null,
        },
      },
      "Final terms sent to the buyer.",
    );
  }

  async function recordPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    await mutate(
      `mutation RecordPayment($orderNumber: String!, $amount: Int!, $method: PaymentMethod!, $reference: String) {
        recordPayment(orderNumber: $orderNumber, amount: $amount, method: $method, reference: $reference) { id }
      }`,
      {
        orderNumber: selected.orderNumber,
        amount: amount(form.get("amount")),
        method: String(form.get("method")),
        reference: String(form.get("reference") ?? "").trim() || null,
      },
      "Payment recorded. Verify it separately after checking the funds.",
    );
    event.currentTarget.reset();
  }

  async function dispatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    await mutate(
      `mutation DispatchOrder($input: DispatchInput!) { dispatchOrder(input: $input) { id } }`,
      {
        input: {
          orderNumber: selected.orderNumber,
          courier: String(form.get("courier") ?? ""),
          trackingNumber: String(form.get("trackingNumber") ?? "").trim() || null,
          notes: String(form.get("notes") ?? "").trim() || null,
        },
      },
      "Dispatch details recorded and buyer notifications queued.",
    );
  }

  async function signOut() {
    try {
      await logout();
      router.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn’t sign you out.");
    }
  }

  if (sessionLoading) return <main className="admin-page"><div className="app-loading">Checking staff access…</div></main>;
  if (!user || !["ADMIN", "ORDER_OPERATOR"].includes(user.role)) {
    return (
      <main className="admin-page">
        <div className="admin-content">
          <div className="account-empty">
            <span className="account-empty-icon"><CircleAlert size={23} /></span>
            <h2>Staff sign-in required.</h2>
            <p>Sign in with an authorized shop account to access requests and customer details.</p>
            <Link className="button button-dark" href="/login?returnTo=%2Fadmin">Staff sign in</Link>
            <Link className="forgot-link" href="/">Back to the shop</Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="admin-page">
      <header className="admin-topbar">
        <Link href="/" className="brand"><span className="brand-mark"><Music2 size={20} /></span><span className="brand-name">new chandan<span>musicals</span></span></Link>
        <div className="admin-topbar-right">
          <span className="admin-workspace-label">SHOP WORKSPACE · {user.role === "ADMIN" ? "ADMIN" : "ORDER OPERATOR"}</span>
          <Link href="/" className="workspace-back"><ArrowLeft size={15} /> View storefront</Link>
          {user.role === "ADMIN" && <Link href="/admin/products" className="workspace-back">Products</Link>}
          {user.role === "ADMIN" && <Link href="/admin/settings" className="workspace-back">Settings</Link>}
          <button className="account-signout" onClick={() => void signOut()}><LogOut size={13} /> Sign out</button>
        </div>
      </header>
      <div className="admin-content">
        <div className="admin-page-heading">
          <div><div className="eyebrow"><span className="eyebrow-line" /> A GOOD DAY AT THE SHOP</div><h1>Morning, <em>music maker.</em></h1><p>Review requests, confirm terms, and keep each order moving.</p></div>
          <div className="admin-date">{total} REQUEST{total === 1 ? "" : "S"} MATCH THESE FILTERS</div>
        </div>
        {dashboard && <section className="admin-metrics" aria-label="Order summary">
          <Metric label="NEW REQUESTS" value={dashboard.requested} icon={<CircleAlert size={17} />} />
          <Metric label="AWAITING PAYMENT" value={dashboard.awaitingPayment} icon={<Clock3 size={17} />} />
          <Metric label="READY TO DISPATCH" value={dashboard.readyToDispatch} icon={<PackageCheck size={17} />} />
          <Metric label="ON ITS WAY" value={dashboard.dispatched} icon={<Truck size={17} />} />
        </section>}
        {error && <p className="form-message error" role="alert">{error}</p>}
        {message && <p className="form-message" role="status">{message}</p>}
        <section className="admin-orders-section">
          <div className="admin-orders-heading">
            <div><h2>The request book</h2><p>All updates are saved to the shop database and audit history.</p></div>
            <label className="admin-search"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search requests or customers" aria-label="Search requests" /></label>
          </div>
          <div className="admin-filter-row">
            <label>Status<select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option>{statuses.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label>
            <label>From<input type="date" value={fromDate} onChange={(event) => { setFromDate(event.target.value); setPage(1); }} /></label>
            <label>To<input type="date" value={toDate} onChange={(event) => { setToDate(event.target.value); setPage(1); }} /></label>
          </div>
          {busy && !orders.length ? <div className="app-loading">Loading requests…</div> : <div className="admin-order-layout">
            <div className="admin-order-list">
              {orders.length ? orders.map((order) => (
                <button key={order.id} className={`admin-order-row ${selectedNumber === order.orderNumber ? "selected" : ""}`} onClick={() => setSelectedNumber(order.orderNumber)}>
                  <span className="admin-order-row-top"><strong>{order.orderNumber}</strong><span>{new Date(order.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span></span>
                  <span className="admin-order-customer">{order.customer.name}</span>
                  <span className="admin-order-row-bottom"><span>{order.items.reduce((sum, item) => sum + item.quantity, 0)} items · {formatPrice(order.finalAmount ?? order.subtotal)}{order.items.some((item) => item.priceMode === "QUOTE") && order.finalAmount === null ? "+" : ""}</span><span className={`admin-status status-${order.status.toLowerCase().replaceAll("_", "-")}`}>{statusLabel(order.status)}</span></span>
                </button>
              )) : <div className="admin-list-empty"><PackageCheck size={22} /><strong>{busy ? "Loading requests…" : "No requests match."}</strong><span>Adjust your filters or check back later.</span></div>}
              <div className="catalog-pagination">
                <button className="button button-outline" disabled={page <= 1 || busy} onClick={() => setPage((value) => value - 1)}>Previous</button>
                <span>Page {page}</span>
                <button className="button button-outline" disabled={!hasNextPage || busy} onClick={() => setPage((value) => value + 1)}>Next</button>
              </div>
            </div>
            <div className="admin-order-detail">
              {selected ? <OrderDetail key={selected.id} order={selected} events={events} busy={busy} onMutate={mutate} onSaveNotes={saveNotes} onConfirmTerms={confirmTerms} onRecordPayment={recordPayment} onDispatch={dispatch} /> : <div className="detail-placeholder"><span className="detail-placeholder-icon"><ArrowLeft size={20} /></span><h3>No request selected.</h3><p>Choose an order from the request book to inspect its details.</p></div>}
            </div>
          </div>}
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return <div className="metric-card"><span className="metric-icon">{icon}</span><span className="metric-label">{label}</span><strong>{value}</strong></div>;
}

function OrderDetail({
  order,
  events,
  busy,
  onMutate,
  onSaveNotes,
  onConfirmTerms,
  onRecordPayment,
  onDispatch,
}: {
  order: Order;
  events: OrderEvent[];
  busy: boolean;
  onMutate: (query: string, variables: Record<string, unknown>, success: string) => Promise<void>;
  onSaveNotes: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onConfirmTerms: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onRecordPayment: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onDispatch: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const [notes, setNotes] = useState(order.internalNotes ?? "");

  return <>
    <div className="detail-heading"><div><span className="detail-kicker">REQUEST DETAILS</span><h3>{order.orderNumber}</h3></div><span className={`admin-status status-${order.status.toLowerCase().replaceAll("_", "-")}`}>{statusLabel(order.status)}</span></div>
    <div className="detail-block"><span className="detail-label">THE CUSTOMER</span><strong>{order.customer.name}</strong>{order.customer.phone && <a href={`tel:${order.customer.phone}`}>{order.customer.phone}</a>}{order.customer.email && <a href={`mailto:${order.customer.email}`}>{order.customer.email}</a>}<span>{order.address.recipientName} · {order.address.phone}<br />{order.address.line1}{order.address.line2 ? `, ${order.address.line2}` : ""}<br />{order.address.city}, {order.address.state} {order.address.postalCode}</span>{order.buyerNotes && <p>Buyer note: {order.buyerNotes}</p>}{order.termsMessage && <p>Message sent with final terms: {order.termsMessage}</p>}</div>
    <div className="detail-block"><span className="detail-label">THE INSTRUMENTS</span>{order.items.map((item) => <div className="detail-item" key={item.id}><span><strong>{item.quantity} ×</strong> {item.name}{item.agreedVariant ? ` · ${item.agreedVariant}` : ""}</span><strong>{item.agreedUnitPrice === null ? item.priceMode === "QUOTE" ? "Quote" : "To confirm" : formatPrice(item.quantity * item.agreedUnitPrice)}</strong></div>)}<div className="detail-total"><span>{order.finalAmount === null ? "Indicative item total" : "Confirmed total"}</span><strong>{formatPrice(order.finalAmount ?? order.subtotal)}</strong></div></div>
    {order.cancellationReason && <div className="detail-block"><span className="detail-label">CANCELLATION REASON</span><p>{order.cancellationReason}</p>{order.paymentStatus === "REFUND_PENDING" && <strong>Refund follow-up required</strong>}</div>}
    {order.status === "REQUESTED" && <button className="button button-dark" disabled={busy} onClick={() => void onMutate("mutation StartReview($orderNumber: String!) { startOrderReview(orderNumber: $orderNumber) { id } }", { orderNumber: order.orderNumber }, "Request moved to review.")}>Start review</button>}
    {order.status === "REVIEWING" || order.status === "AWAITING_BUYER_CONFIRMATION" ? <form className="detail-block request-form" onSubmit={(event) => void onConfirmTerms(event)}><span className="detail-label">CONFIRM FINAL TERMS</span>{order.items.map((item) => <div key={item.id} className="terms-item"><strong>{item.name}</strong><div className="form-row"><label>Quantity<input name={`quantity-${item.id}`} type="number" min="1" max={item.requestedQuantity} defaultValue={item.quantity || item.requestedQuantity} required /></label><label>Unit price (₹)<input name={`price-${item.id}`} type="number" min="0" max="100000000" defaultValue={item.agreedUnitPrice ?? item.requestedUnitPrice ?? 0} required /></label></div><label>Variant / finish<input name={`variant-${item.id}`} defaultValue={item.agreedVariant ?? ""} maxLength={200} /></label></div>)}<div className="form-row"><label>Delivery fee (₹)<input name="deliveryFee" type="number" min="0" max="100000000" defaultValue={order.deliveryFee} required /></label><label>Discount (₹)<input name="discount" type="number" min="0" max="100000000" defaultValue={order.discount} required /></label></div><label>Message for the buyer<textarea name="buyerMessage" rows={2} maxLength={1000} /></label><button className="button button-dark" disabled={busy}>Send final terms</button></form> : null}
    <form className="detail-block request-form" onSubmit={(event) => void onSaveNotes(event)}><label className="detail-label" htmlFor={`staff-note-${order.id}`}>PRIVATE STAFF NOTES</label><textarea id={`staff-note-${order.id}`} name="notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} maxLength={5000} placeholder="Call notes and follow-up…" /><button className="button button-outline" disabled={busy}>Save notes</button></form>
    <div className="detail-block payment-block"><span className="detail-label">PAYMENT · RECORD AND VERIFY SEPARATELY</span><span className="payment-status-value"><CreditCard size={15} />{order.paymentStatus.replaceAll("_", " ")}</span>{order.paymentRecords?.map((payment) => <div className="detail-item" key={payment.id}><span>{formatPrice(payment.amount)} · {payment.method.replaceAll("_", " ")}{payment.reference ? ` · ${payment.reference}` : ""}</span>{payment.verifiedAt ? <strong>Verified</strong> : <button className="verify-button" disabled={busy} onClick={() => void onMutate("mutation VerifyPayment($paymentRecordId: ID!) { verifyPayment(paymentRecordId: $paymentRecordId) { id } }", { paymentRecordId: payment.id }, "Payment verification recorded.")}><Check size={14} /> Verify</button>}</div>)}
      {order.status === "AWAITING_PAYMENT" && <form className="request-form" onSubmit={(event) => void onRecordPayment(event)}><div className="form-row"><label>Amount received (₹)<input name="amount" type="number" min="1" max={order.finalAmount ?? undefined} required /></label><label>Method<select name="method"><option value="UPI">UPI</option><option value="BANK_TRANSFER">Bank transfer</option><option value="CASH">Cash</option><option value="CARD_OFFLINE">Card (offline)</option><option value="OTHER">Other</option></select></label></div><label>Reference (optional)<input name="reference" maxLength={200} /></label><button className="button button-outline" disabled={busy}>Record payment</button></form>}
    </div>
    {order.status === "PAYMENT_VERIFIED" && <button className="button button-dark" disabled={busy} onClick={() => void onMutate("mutation MarkReady($orderNumber: String!) { markReadyToDispatch(orderNumber: $orderNumber) { id } }", { orderNumber: order.orderNumber }, "Order is ready to dispatch.")}>Mark ready to dispatch</button>}
    {order.status === "READY_TO_DISPATCH" && <form className="detail-block request-form" onSubmit={(event) => void onDispatch(event)}><span className="detail-label">DISPATCH AND TRACKING</span><label>Courier<input name="courier" maxLength={100} required /></label><label>Tracking number<input name="trackingNumber" maxLength={200} /></label><label>Dispatch note<input name="notes" maxLength={1000} /></label><button className="button button-dark" disabled={busy}>Record dispatch</button></form>}
    {order.status === "DISPATCHED" && <><div className="detail-block"><span className="detail-label">SHIPMENTS</span>{order.shipments.map((shipment) => <p key={shipment.dispatchedAt}>{shipment.courier}{shipment.trackingNumber ? ` · ${shipment.trackingNumber}` : ""}</p>)}</div><button className="button button-dark" disabled={busy} onClick={() => void onMutate("mutation MarkDelivered($orderNumber: String!) { markDelivered(orderNumber: $orderNumber) { id } }", { orderNumber: order.orderNumber }, "Order marked as delivered.")}>Mark delivered</button></>}
    {order.status === "CANCELLED" && order.paymentStatus === "REFUND_PENDING" && <form className="detail-block request-form" onSubmit={(event) => { event.preventDefault(); const reference = String(new FormData(event.currentTarget).get("reference") ?? "").trim() || null; void onMutate("mutation MarkRefunded($orderNumber: String!, $reference: String) { markRefunded(orderNumber: $orderNumber, reference: $reference) { id } }", { orderNumber: order.orderNumber, reference }, "Refund completion recorded in the audit history."); }}><span className="detail-label">REFUND FOLLOW-UP</span><p>Reconcile the refund outside this app, then record completion here.</p><label>Refund reference (optional)<input name="reference" maxLength={200} /></label><button className="button button-outline" disabled={busy}>Mark refund completed</button></form>}
    {!["CANCELLED", "DELIVERED", "DISPATCHED"].includes(order.status) && <form className="detail-block request-form" onSubmit={(event) => { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim(); if (reason && window.confirm("Cancel this request? Any refund follow-up must be handled separately.")) void onMutate("mutation CancelOrder($orderNumber: String!, $reason: String!) { cancelOrder(orderNumber: $orderNumber, reason: $reason) { id } }", { orderNumber: order.orderNumber, reason }, "Request cancelled. Review any refund follow-up separately."); }}><span className="detail-label">CANCELLATION</span><label>Reason<input name="reason" maxLength={500} minLength={3} required /></label><button className="button button-outline" disabled={busy}>Cancel request</button></form>}
    <div className="detail-block"><span className="detail-label">AUDIT HISTORY</span>{events.map((event) => <div className="detail-item" key={event.id}><span><strong>{event.action.replaceAll("_", " ")}</strong><br />{event.actorName ?? "System"} · {new Date(event.createdAt).toLocaleString()}{event.metadata ? <small>{JSON.stringify(event.metadata)}</small> : null}</span>{event.fromStatus && event.toStatus && <small>{statusLabel(event.fromStatus)} → {statusLabel(event.toStatus)}</small>}</div>)}</div>
  </>;
}
