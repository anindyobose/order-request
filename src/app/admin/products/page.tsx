"use client";

import { Download, PackagePlus, Save, Trash2, Upload } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useSession } from "@/components/auth-provider";
import { AppHeader } from "@/components/app-header";
import { CatalogProduct, graphqlRequest, PRODUCT_FIELDS } from "@/lib/api";

type Draft = {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  brand: string;
  price: string;
  priceMode: "FIXED" | "QUOTE";
  stockStatus: "IN_STOCK" | "LIMITED" | "OUT_OF_STOCK";
  active: boolean;
  sortOrder: string;
};

const emptyDraft: Draft = {
  id: "",
  sku: "",
  slug: "",
  name: "",
  description: "",
  category: "",
  brand: "",
  price: "0",
  priceMode: "FIXED",
  stockStatus: "IN_STOCK",
  active: false,
  sortOrder: "0",
};

function toDraft(product: CatalogProduct): Draft {
  return {
    id: product.id,
    sku: product.sku,
    slug: product.slug,
    name: product.name,
    description: product.description,
    category: product.category,
    brand: product.brand ?? "",
    price: String(product.price),
    priceMode: product.priceMode,
    stockStatus: product.stockStatus,
    active: product.active,
    sortOrder: String(product.sortOrder),
  };
}

export default function AdminProductsPage() {
  const { user, loading } = useSession();
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);

  const loadProducts = useCallback(async () => {
    if (user?.role !== "ADMIN") return;
    try {
      const result = await graphqlRequest<{ adminProducts: CatalogProduct[] }>(
        `query AdminProducts($includeArchived: Boolean) { adminProducts(includeArchived: $includeArchived) { ${PRODUCT_FIELDS} } }`,
        { includeArchived },
      );
      setProducts(result.adminProducts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The product catalog couldn’t be loaded.");
    }
  }, [includeArchived, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProducts(), 0);
    return () => window.clearTimeout(timer);
  }, [loadProducts]);

  function editProduct(product: CatalogProduct) {
    setDraft(toDraft(product));
    setError("");
    setMessage("");
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const input = {
        id: draft.id || null,
        sku: draft.sku.trim(),
        slug: draft.slug.trim().toLowerCase(),
        name: draft.name.trim(),
        description: draft.description.trim(),
        category: draft.category.trim(),
        brand: draft.brand.trim() || null,
        price: Number(draft.price),
        priceMode: draft.priceMode,
        stockStatus: draft.stockStatus,
        active: draft.active,
        sortOrder: Number(draft.sortOrder),
      };
      const result = await graphqlRequest<{ saveProduct: CatalogProduct }>(
        `mutation SaveProduct($input: ProductInput!) { saveProduct(input: $input) { ${PRODUCT_FIELDS} } }`,
        { input },
      );
      setDraft(toDraft(result.saveProduct));
      setMessage("Product saved.");
      await loadProducts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The product couldn’t be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function importProducts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get("file");
    if (!(file instanceof File)) {
      setError("Choose an .xlsx or .csv product file.");
      return;
    }
    if (file.size < 1 || file.size > 5 * 1024 * 1024) {
      setError("Spreadsheet files must be between 1 byte and 5 MB.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const body = new FormData();
      body.set("file", file);
      const response = await fetch("/api/admin/products/import", {
        method: "POST",
        credentials: "same-origin",
        body,
      });
      const result = await response.json() as {
        created?: number;
        updated?: number;
        error?: string;
      };
      if (!response.ok || result.created === undefined || result.updated === undefined) {
        throw new Error(result.error ?? "The product spreadsheet could not be imported.");
      }
      form.reset();
      setMessage(`Import complete: ${result.created} added, ${result.updated} updated.`);
      await loadProducts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The product spreadsheet could not be imported.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.id) {
      setError("Save this product before adding images.");
      return;
    }
    const form = event.currentTarget;
    const file = new FormData(form).get("file");
    if (!(file instanceof File)) {
      setError("Choose an image to upload.");
      return;
    }
    if ((products.find((product) => product.id === draft.id)?.images.length ?? 0) >= 12) {
      setError("A product can have at most 12 images.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("productId", draft.id);
      const response = await fetch("/api/uploads", { method: "POST", credentials: "same-origin", body });
      const result = await response.json() as { url?: string; error?: string };
      if (!response.ok || !result.url) throw new Error(result.error ?? "The image upload failed.");
      const images = [...(products.find((product) => product.id === draft.id)?.images ?? []), { url: result.url, altText: file.name.slice(0, 200) || draft.name, sortOrder: products.find((product) => product.id === draft.id)?.images.length ?? 0 }];
      await graphqlRequest(
        `mutation SetProductImages($productId: ID!, $images: [ProductImageInput!]!) { setProductImages(productId: $productId, images: $images) { id } }`,
        { productId: draft.id, images },
      );
      form.reset();
      setMessage("Product image uploaded.");
      await loadProducts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The image couldn’t be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  async function removeImage(imageId: string) {
    if (!window.confirm("Remove this product image?")) return;
    setBusy(true);
    setError("");
    try {
      await graphqlRequest(
        "mutation RemoveProductImage($imageId: ID!) { removeProductImage(imageId: $imageId) }",
        { imageId },
      );
      setMessage("Product image removed.");
      await loadProducts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The image couldn’t be removed.");
    } finally {
      setBusy(false);
    }
  }

  async function archiveProduct(productId: string) {
    if (!window.confirm("Archive this product? It will disappear from the public catalog.")) return;
    setBusy(true);
    setError("");
    try {
      await graphqlRequest(
        "mutation ArchiveProduct($productId: ID!) { archiveProduct(productId: $productId) { id } }",
        { productId },
      );
      setMessage("Product archived.");
      if (draft.id === productId) setDraft(emptyDraft);
      await loadProducts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The product couldn’t be archived.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="admin-page"><div className="app-loading">Checking administrator access…</div></main>;
  if (!user || user.role !== "ADMIN") return <main className="admin-page"><div className="admin-content"><section className="account-empty"><h1>Administrator access required.</h1><Link className="button button-dark" href="/login?returnTo=%2Fadmin%2Fproducts">Sign in</Link></section></div></main>;

  const selected = products.find((product) => product.id === draft.id);
  return (
    <main className="admin-page">
      <AppHeader variant="admin" />
      <div className="admin-content">
        <div className="admin-page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> SHOP CATALOG</div><h1>Instruments, <em>well cared for.</em></h1><p>Create, update, publish or archive catalog products and their images.</p></div></div>
        {error && <p className="form-message error" role="alert">{error}</p>}{message && <p className="form-message" role="status">{message}</p>}
        <section className="admin-orders-section product-import-section">
          <div className="admin-orders-heading">
            <div><h2>Import products &amp; images</h2><p>Upload an Excel workbook or CSV to add products and update matching SKUs.</p></div>
            <div className="product-template-links">
              <a className="button button-outline" href="/product-import-template.xlsx" download><Download size={15} /> Excel template</a>
              <a className="button button-outline" href="/product-import-template.csv" download><Download size={15} /> CSV template</a>
            </div>
          </div>
          <p className="account-help">Use the first worksheet and keep the template’s column names. To import a picture, embed one JPEG or PNG in that product’s row in the Image column. It replaces the main product image while keeping the rest of the gallery. CSV files cannot contain embedded pictures. Matching SKUs are updated, and the whole file is checked before any changes are saved (up to 1,000 rows, 5 MB).</p>
          <form className="request-form product-import-form" onSubmit={(event) => void importProducts(event)}>
            <label>Choose an Excel workbook (.xlsx) or CSV to upload<input name="file" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" required /></label>
            <button className="button button-dark" disabled={busy}><Upload size={15} /> {busy ? "Importing…" : "Import products"}</button>
          </form>
        </section>
        <div className="product-admin-layout">
          <section className="admin-orders-section product-admin-list"><div className="admin-orders-heading"><div><h2>Products ({products.length})</h2><p>Unpublished products are not shown to shoppers.</p></div><button className="profile-add-button" onClick={() => { setDraft(emptyDraft); setError(""); setMessage(""); }}><PackagePlus size={15} /> New product</button></div><label className="include-archived"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> Include archived</label>
            <div className="admin-product-list">{products.map((product) => <button key={product.id} className={`admin-order-row ${draft.id === product.id ? "selected" : ""}`} onClick={() => editProduct(product)}><span className="admin-order-row-top"><strong>{product.name}</strong><span>{product.active ? "Published" : product.archived ? "Archived" : "Draft"}</span></span><span className="admin-order-row-bottom"><span>{product.sku} · {product.category}</span><span>{product.priceMode === "QUOTE" ? "Quote" : `₹${product.price.toLocaleString("en-IN")}`}</span></span></button>)}</div>
          </section>
          <section className="admin-orders-section">
            <h2 className="profile-section-title">{draft.id ? "Edit product" : "Add a product"}</h2>
            <form className="request-form product-admin-form" onSubmit={(event) => void saveProduct(event)}>
              <div className="form-row"><label>Product name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={160} required /></label><label>SKU<input value={draft.sku} onChange={(event) => setDraft({ ...draft, sku: event.target.value })} maxLength={80} required /></label></div>
              <label>URL slug<input value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-") })} maxLength={120} required /></label>
              <label>Description<textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} maxLength={5000} rows={5} required /></label>
              <div className="form-row"><label>Category<input value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} maxLength={100} required /></label><label>Brand<input value={draft.brand} onChange={(event) => setDraft({ ...draft, brand: event.target.value })} maxLength={100} /></label></div>
              <div className="form-row"><label>Pricing<select value={draft.priceMode} onChange={(event) => setDraft({ ...draft, priceMode: event.target.value as Draft["priceMode"] })}><option value="FIXED">Fixed price</option><option value="QUOTE">Request a quote</option></select></label><label>Price (₹)<input type="number" min="0" max="100000000" value={draft.price} onChange={(event) => setDraft({ ...draft, price: event.target.value })} required /></label></div>
              <div className="form-row"><label>Availability<select value={draft.stockStatus} onChange={(event) => setDraft({ ...draft, stockStatus: event.target.value as Draft["stockStatus"] })}><option value="IN_STOCK">In stock</option><option value="LIMITED">Limited</option><option value="OUT_OF_STOCK">Out of stock</option></select></label><label>Sort order<input type="number" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: event.target.value })} /></label></div>
              <label className="check-field"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> Publish in public catalog</label>
              <button className="button button-dark" disabled={busy}><Save size={15} /> {busy ? "Saving…" : "Save product"}</button>
            </form>
            {draft.id && <div className="product-image-manager"><h3>Product images</h3><p className="account-help">Upload images directly here, or include them in the Excel import above. Save a new product before uploading images.</p>{selected?.images.map((image) => <div className="managed-image" key={image.id}><Image src={image.url} alt={image.altText} width={48} height={48} unoptimized /><span>{image.altText}</span><button aria-label={`Remove ${image.altText}`} disabled={busy} onClick={() => void removeImage(image.id)}><Trash2 size={14} /></button></div>)}<form className="request-form" onSubmit={(event) => void uploadImage(event)}><label>Upload JPEG, PNG or WebP (max 5 MB)<input name="file" type="file" accept="image/jpeg,image/png,image/webp" required /></label><button className="button button-outline" disabled={busy}><Upload size={14} /> Upload image</button></form><button className="button button-outline" disabled={busy || draft.id === "" || selected?.archived} onClick={() => void archiveProduct(draft.id)}>Archive product</button></div>}
          </section>
        </div>
      </div>
    </main>
  );
}
