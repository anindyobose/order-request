"use client";

import { ArrowLeft, ArrowRight, Check, Music2, Plus, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense } from "react";
import { useCallback, useEffect, useState } from "react";
import { graphqlRequest, PRODUCT_FIELDS, CatalogProduct } from "@/lib/api";
import { updateCart, useCart } from "@/lib/cart-store";
import { formatPrice } from "@/lib/store";

const availability: Record<CatalogProduct["stockStatus"], string> = {
  IN_STOCK: "In stock",
  LIMITED: "Limited availability",
  OUT_OF_STOCK: "Currently unavailable",
};

function ProductDetailsContent() {
  const { slug } = useParams<{ slug: string }>();
  const cart = useCart();
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [added, setAdded] = useState(false);

  const loadProduct = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await graphqlRequest<{ product: CatalogProduct | null }>(
        `query ProductDetails($slug: String!) { product(slug: $slug) { ${PRODUCT_FIELDS} } }`,
        { slug },
      );
      setProduct(result.product);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This instrument couldn’t be loaded.");
    } finally {
      setLoading(false);
    }

  }, [slug]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProduct(), 0);
    return () => window.clearTimeout(timer);
  }, [loadProduct]);

  function addToBag() {
    if (!product || product.stockStatus === "OUT_OF_STOCK") return;
    updateCart((current) => {
      const existing = current.find((line) => line.productId === product.id);
      if (!existing) return current.length >= 50 ? current : [...current, { productId: product.id, quantity: 1 }];
      return current.map((line) => line.productId === product.id ? { ...line, quantity: Math.min(50, line.quantity + 1) } : line);
    });
    setAdded(true);
  }

  if (loading) return <main className="product-page"><div className="app-loading">Finding this instrument…</div></main>;

  return (
    <main className="product-page">
      <header className="workspace-header">
        <Link href="/" className="brand"><span className="brand-mark"><Music2 size={20} /></span><span className="brand-name">New Chandan<span>musicals</span></span></Link>
        <Link href="/#shop" className="workspace-back"><ArrowLeft size={15} /> All instruments</Link>
      </header>
      {error ? <section className="product-page-message"><h1>We couldn’t load this instrument.</h1><p role="alert">{error}</p><button className="button button-dark" onClick={() => void loadProduct()}>Try again</button></section> : !product ? <section className="product-page-message"><h1>This instrument has found a new home.</h1><p>It may no longer be available in our catalog.</p><Link className="button button-dark" href="/#shop">Browse instruments <ArrowRight size={15} /></Link></section> : (
        <article className="product-detail">
          <div className="product-detail-image" style={product.images[0] ? { backgroundImage: `url("${product.images[0].url}")` } : undefined}>
            {product.images[0] && <span className="product-image-caption">{product.images[0].altText}</span>}
          </div>
          <div className="product-detail-copy">
            <div className="eyebrow"><span className="eyebrow-line" /> {product.category}</div>
            <h1>{product.name}</h1>
            <p className="product-detail-brand">{product.brand ?? "New Chandan Musicals"}</p>
            <p className="product-detail-price">{product.priceMode === "QUOTE" ? "Request a quote" : formatPrice(product.price)}</p>
            <p className="product-detail-stock"><i className={product.stockStatus === "OUT_OF_STOCK" ? "stock-out" : ""} />{availability[product.stockStatus]}</p>
            <p className="product-detail-description">{product.description}</p>
            <div className="product-detail-actions">
              <button className="button button-dark" onClick={addToBag} disabled={product.stockStatus === "OUT_OF_STOCK"}>{added ? <><Check size={16} /> Added to request bag</> : <><Plus size={16} /> Add to request bag</>}</button>
              {cart.length > 0 && <Link className="button button-outline" href="/#shop">Continue browsing <ArrowRight size={15} /></Link>}
            </div>
            <p className="product-detail-note"><ShieldCheck size={16} /> No payment is taken when you send a request. The shop will confirm availability and final terms with you.</p>
          </div>
        </article>
      )}
    </main>
  );
}

export default function ProductDetailsPage() {
  return <Suspense fallback={<main className="product-page"><div className="app-loading">Finding this instrument…</div></main>}><ProductDetailsContent /></Suspense>;
}
