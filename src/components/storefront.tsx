"use client";

import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleHelp,
  Headphones,
  Heart,
  Minus,
  Music2,
  Plus,
  Search,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Truck,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { formatPrice } from "@/lib/store";
import { updateCart, useCart } from "@/lib/cart-store";
import { useSession } from "@/components/auth-provider";
import { AppHeader } from "@/components/app-header";
import { Address, CatalogProduct, graphqlRequest, PRODUCT_FIELDS } from "@/lib/api";

const categoryDesign: Record<string, { icon: string; color: string }> = {
  Guitars: { icon: "♬", color: "category-peach" },
  Keyboards: { icon: "▤", color: "category-blue" },
  Strings: { icon: "⌁", color: "category-lilac" },
  Percussion: { icon: "◉", color: "category-yellow" },
  "Indian classical": { icon: "ॐ", color: "category-yellow" },
};

const stockLabel: Record<CatalogProduct["stockStatus"], string> = {
  IN_STOCK: "In stock",
  LIMITED: "Limited availability",
  OUT_OF_STOCK: "Currently unavailable",
};

export function Storefront() {
  const router = useRouter();
  const { user } = useSession();
  const cart = useCart();
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [cartProducts, setCartProducts] = useState<CatalogProduct[]>([]);
  const [facets, setFacets] = useState<{ categories: Array<{ name: string; count: number }>; brands: Array<{ name: string; count: number }> }>({ categories: [], brands: [] });
  const [productsTotal, setProductsTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [brand, setBrand] = useState("");
  const [priceMode, setPriceMode] = useState("");
  const [availability, setAvailability] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [submittedOrder, setSubmittedOrder] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState("All instruments");
  const [search, setSearch] = useState("");
  const [requestError, setRequestError] = useState("");
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressesLoading, setAddressesLoading] = useState(false);
  const [selectedAddressId, setSelectedAddressId] = useState("");
  const requestKey = useRef<{ signature: string; key: string } | null>(null);
  const categories = [
    { name: "All instruments", icon: "✳", count: productsTotal },
    ...facets.categories.map((category) => ({
      ...category,
      icon: categoryDesign[category.name]?.icon ?? "✳",
    })),
  ];
  const loadProducts = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const result = await graphqlRequest<{
        products: { items: CatalogProduct[]; total: number; hasNextPage: boolean };
      }>(
        `query Catalog($filter: ProductFilter, $page: PageInput) {
          products(filter: $filter, page: $page) {
            items { ${PRODUCT_FIELDS} }
            total hasNextPage
          }
        }`,
        {
          filter: {
            ...(activeCategory !== "All instruments" ? { category: activeCategory } : {}),
            ...(search.trim() ? { search: search.trim() } : {}),
            ...(brand ? { brand } : {}),
            ...(priceMode ? { priceMode } : {}),
            ...(availability ? { stockStatus: availability } : {}),
            ...(minPrice && /^\d+$/.test(minPrice) ? { minPrice: Number(minPrice) } : {}),
            ...(maxPrice && /^\d+$/.test(maxPrice) ? { maxPrice: Number(maxPrice) } : {}),
          },
          page: { page, pageSize: 24 },
        },
      );
      setProducts(result.products.items);
      setProductsTotal(result.products.total);
      setHasNextPage(result.products.hasNextPage);
      setCatalogError("");
    } catch (cause) {
      setProducts([]);
      setProductsTotal(0);
      setCatalogError(cause instanceof Error ? cause.message : "The instrument catalog couldn’t be loaded.");
    } finally {
      setCatalogLoading(false);
    }
  }, [activeCategory, availability, brand, maxPrice, minPrice, page, priceMode, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProducts(), 0);
    return () => window.clearTimeout(timer);
  }, [loadProducts]);

  useEffect(() => {
    let active = true;
    const productIds = [...new Set(cart.map((line) => line.productId))];
    if (!productIds.length) {
      const timer = window.setTimeout(() => setCartProducts([]), 0);
      return () => window.clearTimeout(timer);
    }
    graphqlRequest<{ products: { items: CatalogProduct[] } }>(
      `query RequestBagProducts($filter: ProductFilter, $page: PageInput) {
        products(filter: $filter, page: $page) { items { ${PRODUCT_FIELDS} } }
      }`,
      { filter: { ids: productIds }, page: { page: 1, pageSize: 50 } },
    )
      .then((result) => {
        if (active) setCartProducts(result.products.items);
      })
      .catch((cause) => {
        if (active) setRequestError(cause instanceof Error ? cause.message : "Your request bag couldn’t be loaded.");
      });
    return () => {
      active = false;
    };
  }, [cart, router]);

  useEffect(() => {
    let active = true;
    graphqlRequest<{ catalogFacets: typeof facets }>(`
      query CatalogFacets { catalogFacets { categories { name count } brands { name count } } }
    `)
      .then((result) => {
        if (active) setFacets(result.catalogFacets);
      })
      .catch((cause) => {
        if (active) setCatalogError(cause instanceof Error ? cause.message : "Catalog filters couldn’t be loaded.");
      });
    return () => {
      active = false;
    };
  }, []);

  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const cartTotal = cart.reduce((sum, line) => {
    const product = cartProducts.find((item) => item.id === line.productId);
    return sum + (product?.price ?? 0) * line.quantity;
  }, 0);
  const quoteCount = cart.reduce((sum, line) => {
    const product = cartProducts.find((item) => item.id === line.productId);
    return sum + (product?.priceMode === "QUOTE" ? line.quantity : 0);
  }, 0);

  function updateQuantity(productId: string, change: number) {
    updateCart((current) => {
      const line = current.find((item) => item.productId === productId);
      if (!line && change > 0) {
        if (current.length >= 50) return current;
        return [...current, { productId, quantity: 1 }];
      }
      if (line && change > 0 && line.quantity >= 50) return current;
      return current
        .map((item) =>
          item.productId === productId
            ? { ...item, quantity: item.quantity + change }
            : item,
        )
        .filter((item) => item.quantity > 0);
    });
  }

  function addToCart(productId: string) {
    updateQuantity(productId, 1);
    setCartOpen(true);
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRequestError("");
    if (!user) {
      router.push("/login?returnTo=%2F");
      return;
    }
    const formData = new FormData(event.currentTarget);
    const addressId = selectedAddressId || null;
    const savedAddress = addresses.find((address) => address.id === addressId);
    const input = {
      items: cart.map((line) => ({ productId: line.productId, quantity: line.quantity })),
      address: {
        ...(savedAddress
          ? {
              recipientName: savedAddress.recipientName,
              phone: savedAddress.phone,
              line1: savedAddress.line1,
              line2: savedAddress.line2,
              city: savedAddress.city,
              state: savedAddress.state,
              postalCode: savedAddress.postalCode,
              addressId: savedAddress.id,
            }
          : {
              recipientName: String(formData.get("recipientName") ?? "").trim(),
              phone: String(formData.get("deliveryPhone") ?? "").trim(),
              line1: String(formData.get("line1") ?? "").trim(),
              line2: String(formData.get("line2") ?? "").trim() || null,
              city: String(formData.get("city") ?? "").trim(),
              state: String(formData.get("state") ?? "").trim(),
              postalCode: String(formData.get("postalCode") ?? "").trim(),
            }),
      },
      buyerNotes: String(formData.get("buyerNotes") ?? "").trim() || null,
    };
    const signature = JSON.stringify(input);
    if (!requestKey.current || requestKey.current.signature !== signature) {
      requestKey.current = { signature, key: crypto.randomUUID() };
    }
    try {
      const result = await graphqlRequest<{ submitOrderRequest: { orderNumber: string } }>(
        `mutation SubmitOrderRequest($input: OrderRequestInput!) {
          submitOrderRequest(input: $input) { orderNumber }
        }`,
        { input: { ...input, idempotencyKey: requestKey.current.key } },
      );
      updateCart(() => []);
      requestKey.current = null;
      setSubmittedOrder(result.submitOrderRequest.orderNumber);
    } catch (cause) {
      setRequestError(cause instanceof Error ? cause.message : "Your request couldn’t be sent. Please try again.");
    }
  }

  useEffect(() => {
    if (!checkoutOpen || !user) return;
    let active = true;
    graphqlRequest<{ myAddresses: Address[] }>(`
      query CheckoutAddresses { myAddresses { id recipientName phone line1 line2 city state postalCode isDefault } }
    `)
      .then((result) => {
        if (!active) return;
        setAddresses(result.myAddresses);
        const defaultAddress = result.myAddresses.find((address) => address.isDefault);
        setSelectedAddressId(defaultAddress?.id ?? "");
      })
      .catch((cause) => {
        if (active) setRequestError(cause instanceof Error ? cause.message : "Your saved delivery addresses couldn’t be loaded.");
      })
      .finally(() => {
        if (active) setAddressesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [checkoutOpen, user]);

  function closeCheckout() {
    setCheckoutOpen(false);
    setSubmittedOrder(null);
  }

  return (
    <main>
      <div className="announcement">
        <span className="announcement-spark">✳</span>
        <p>
          A little music goes a long way. <strong>Free delivery on orders over ₹5,000</strong>
        </p>
        <ArrowRight size={14} aria-hidden="true" />
      </div>

      <AppHeader variant="storefront" itemCount={itemCount} onOpenBag={() => setCartOpen(true)} />

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> FIND YOUR SOUND</div>
          <h1>Good things<br />happen in <em>harmony.</em></h1>
          <p className="hero-description">
            For first notes, late-night songs and everything in between. Find an instrument that feels like yours.
          </p>
          <div className="hero-actions">
            <a href="#shop" className="button button-dark">Explore instruments <ArrowRight size={16} /></a>
            <a href="#our-story" className="text-link">A little about us <ArrowDownRight size={15} /></a>
          </div>
          <div className="hero-note">
            <div className="avatar-stack" aria-hidden="true">
              <span>R</span><span>A</span><span>M</span>
            </div>
            <p><strong>Picked with care.</strong><br />Played with joy, since1983.</p>
          </div>
          <span className="hero-doodle doodle-one">♫</span>
          <span className="hero-doodle doodle-two">✳</span>
        </div>
        <div className="hero-image-wrap">
          <div className="hero-image" role="img" aria-label="A musician playing acoustic guitar" />
          <div className="hero-image-grain" />
          <div className="hero-sticker"><span>MADE FOR</span><strong>the love<br />of music</strong><Music2 size={18} /></div>
          <div className="hero-caption"><span>01 / 04</span><span>MAKE A LITTLE NOISE</span></div>
          <span className="hero-image-star">✳</span>
        </div>
      </section>

      <section className="trust-strip" aria-label="Our service">
        <div><span className="trust-icon"><Headphones size={18} /></span><p>Real people, real advice</p></div>
        <span className="trust-divider" />
        <div><span className="trust-icon"><ShieldCheck size={18} /></span><p>Every instrument checked</p></div>
        <span className="trust-divider" />
        <div><span className="trust-icon"><Truck size={18} /></span><p>Careful delivery, always</p></div>
        <span className="trust-divider" />
        <div><span className="trust-icon"><Heart size={18} /></span><p>A local shop since ’98</p></div>
      </section>

      <section className="collections-section" id="collections">
        <div className="section-heading">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> A PLACE FOR EVERY NOTE</div>
            <h2>Find your <em>kind</em> of music.</h2>
          </div>
          <a href="#shop" className="text-link">Browse everything <ArrowUpRight size={15} /></a>
        </div>
        <div className="category-grid">
          {[
            { name: "Guitars", count: facets.categories.find((item) => item.name === "Guitars")?.count ?? 0, icon: "♬", color: "category-peach" },
            { name: "Keyboards", count: facets.categories.find((item) => item.name === "Keyboards")?.count ?? 0, icon: "▤", color: "category-blue" },
            { name: "Strings", count: facets.categories.find((item) => item.name === "Strings")?.count ?? 0, icon: "⌁", color: "category-lilac" },
            { name: "Indian classical", count: facets.categories.find((item) => item.name === "Indian classical")?.count ?? 0, icon: "ॐ", color: "category-yellow" },
          ].map((category) => (
            <button
              className={`category-card ${category.color}`}
              key={category.name}
              onClick={() => {
                setActiveCategory(category.name);
                document.getElementById("shop")?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              <span className="category-icon">{category.icon}</span>
              <span className="category-arrow"><ArrowUpRight size={18} /></span>
              <span className="category-title">{category.name}</span>
              <span className="category-count">{category.count} instruments</span>
            </button>
          ))}
        </div>
      </section>

      <section className="shop-section" id="shop">
        <div className="section-heading shop-heading">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> THE GOOD STUFF</div>
            <h2>Instruments with <em>character.</em></h2>
            <p className="section-subtitle">A few of our current favourites. Each one ready for a new story.</p>
          </div>
          <div className="shop-tools">
            <label className="search-box">
              <Search size={17} aria-hidden="true" />
              <input
                type="search"
                placeholder="Find your instrument"
                value={search}
                maxLength={100}
                onChange={(event) => { setSearch(event.target.value); setPage(1); }}
                aria-label="Search instruments"
              />
              <kbd>/</kbd>
            </label>
          </div>
        </div>

        <div className="shop-catalog">
          <aside className="category-sidebar" aria-label="Filter by category">
            <span className="filter-label">CATEGORIES</span>
            {categories.map((category) => (
              <button
                key={category.name}
                className={`filter-button ${activeCategory === category.name ? "active" : ""}`}
                onClick={() => { setActiveCategory(category.name); setPage(1); }}
              >
                <span className="filter-symbol">{category.icon}</span>
                <span>{category.name}</span>
                <span className="filter-count">{category.count}</span>
              </button>
            ))}
            <div className="help-card">
              <span className="help-icon"><CircleHelp size={18} /></span>
              <strong>Need a hand?</strong>
              <p>Choosing an instrument is easier with a friend.</p>
              <a href="#visit">Talk to our team <ArrowRight size={13} /></a>
            </div>
          </aside>

          <div className="product-area">
            <div className="product-toolbar">
              <span><strong>{productsTotal}</strong> instruments to fall for</span>
              <div className="catalog-filter-controls">
                <label className="catalog-select"><span>BRAND</span><select value={brand} onChange={(event) => { setBrand(event.target.value); setPage(1); }} aria-label="Filter by brand"><option value="">All brands</option>{facets.brands.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
                <label className="catalog-select"><span>PRICE</span><select value={priceMode} onChange={(event) => { setPriceMode(event.target.value); setPage(1); }} aria-label="Filter by pricing"><option value="">Any price</option><option value="FIXED">Priced</option><option value="QUOTE">Request a quote</option></select></label>
                <label className="catalog-select"><span>AVAILABILITY</span><select value={availability} onChange={(event) => { setAvailability(event.target.value); setPage(1); }} aria-label="Filter by availability"><option value="">Any stock status</option><option value="IN_STOCK">In stock</option><option value="LIMITED">Limited</option><option value="OUT_OF_STOCK">Unavailable</option></select></label>
                <label className="catalog-price-input"><span>MIN ₹</span><input value={minPrice} onChange={(event) => { setMinPrice(event.target.value.replace(/\D/g, "")); setPage(1); }} inputMode="numeric" aria-label="Minimum price" /></label>
                <label className="catalog-price-input"><span>MAX ₹</span><input value={maxPrice} onChange={(event) => { setMaxPrice(event.target.value.replace(/\D/g, "")); setPage(1); }} inputMode="numeric" aria-label="Maximum price" /></label>
              </div>
            </div>
            {catalogLoading ? (
              <div className="app-loading" role="status">Finding your sound…</div>
            ) : catalogError ? (
              <div className="empty-search"><CircleHelp size={26} /><h3>The catalog is having a little trouble.</h3><p>{catalogError}</p><button className="button button-dark" onClick={() => void loadProducts()}>Try again</button></div>
            ) : products.length > 0 ? (
              <div className="product-grid">
                {products.map((product, index) => (
                  <article className="product-card" key={product.id}>
                    <div
                      className={`product-image product-${categoryDesign[product.category]?.color.replace("category-", "") ?? "cream"}`}
                      style={product.images[0] ? { backgroundImage: `url("${product.images[0].url}")` } : undefined}
                    >
                      {product.priceMode === "QUOTE" && <span className="product-badge">GET A QUOTE</span>}
                      <button className="quick-add" onClick={() => addToCart(product.id)} aria-label={`Add ${product.name} to request bag`}>{product.priceMode === "QUOTE" ? "Ask us about this" : "Add to request"} <ArrowUpRight size={14} /></button>
                      <span className="image-index">{String((page - 1) * 24 + index + 1).padStart(2, "0")}</span>
                    </div>
                    <div className="product-details">
                      <div className="product-overline"><span>{product.category}</span><span className="stock-indicator"><i className={product.stockStatus === "OUT_OF_STOCK" ? "stock-out" : ""} />{stockLabel[product.stockStatus]}</span></div>
                      <h3><Link href={`/products/${encodeURIComponent(product.slug)}`}>{product.name}</Link></h3>
                      <div className="product-bottom">
                        <div><span className="maker-name">{product.brand ?? "New Chandan Musicals"}</span><p className="product-price">{product.priceMode === "QUOTE" ? "Request a quote" : formatPrice(product.price)}</p></div>
                        <button
                          className="add-button"
                          onClick={() => addToCart(product.id)}
                          aria-label={`Add ${product.name} to request bag`}
                          disabled={product.stockStatus === "OUT_OF_STOCK"}
                        >
                          <Plus size={18} />
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-search">
                <Search size={28} />
                <h3>No instruments found just yet</h3>
                <p>Try another search or explore all of our instruments.</p>
                <button className="button button-dark" onClick={() => { setSearch(""); setActiveCategory("All instruments"); setBrand(""); setPriceMode(""); setAvailability(""); setMinPrice(""); setMaxPrice(""); setPage(1); }}>Show everything</button>
              </div>
            )}
            {!catalogLoading && !catalogError && products.length > 0 && (
              <div className="catalog-pagination">
                <button className="button button-outline" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button>
                <span>Page {page}</span>
                <button className="button button-outline" disabled={!hasNextPage} onClick={() => setPage((current) => current + 1)}>Next</button>
              </div>
            )}
            <div className="catalog-note"><Sparkles size={15} /> A question about an instrument? <a href="#visit">We’re just a call away.</a></div>
          </div>
        </div>
      </section>

      <section className="story-section" id="our-story">
        <div className="story-photo" role="img" aria-label="A lovingly cared for acoustic instrument in a music shop">
          <div className="story-photo-label"><span>OUR LITTLE CORNER OF MUSIC</span><strong>Since1983</strong></div>
          <span className="story-photo-stamp">LOCAL<br />& LOVING<br />IT</span>
        </div>
        <div className="story-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> MORE THAN A MUSIC SHOP</div>
          <h2>We believe music is for <em>everybody.</em></h2>
          <p>Somewhere between your first shaky chord and the song you can’t stop playing, music becomes yours. We’re here for all of it.</p>
          <p>Since1983, our family shop has helped curious beginners, weekend strummers and lifelong players find the instrument that feels just right.</p>
          <a href="#visit" className="button button-outline">Come say hello <ArrowRight size={15} /></a>
          <span className="story-doodle">♪</span>
        </div>
      </section>

      <section className="visit-section" id="visit">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> THERE’S NOTHING LIKE A TRY</div>
          <h2>Come play a <em>little.</em></h2>
          <p>Pick it up. Play a note. Ask us anything. The kettle’s usually on.</p>
        </div>
        <div className="visit-details">
          <div><span className="visit-detail-label">COME FIND US</span><strong>New Chandan Musicals</strong><span>Visit your neighbourhood store</span></div>
          <div><span className="visit-detail-label">DROP US A LINE</span><strong>We’d love to hear from you</strong><span>Call or message our friendly team</span></div>
          <a className="visit-arrow" href="#shop" aria-label="Browse instruments"><ArrowUpRight size={21} /></a>
        </div>
      </section>

      <footer className="site-footer">
        <div className="footer-top">
          <Link href="/" className="brand footer-brand">
            <span className="brand-mark"><Music2 size={20} strokeWidth={2.4} /></span>
            <span className="brand-name">New Chandan<span>musicals</span></span>
          </Link>
          <p>Good instruments. Good people.<br />A little more music in your day.</p>
          <a href="#shop" className="footer-backtop">Back to the good stuff <ArrowUpRight size={15} /></a>
        </div>
        <div className="footer-bottom">
          <span>© 2026 New Chandan Musicals</span>
          <span>Made with a little bit of music <span className="footer-heart">♥</span></span>
          <div><Link href="/account/orders">My requests</Link>{user && ["ADMIN", "ORDER_OPERATOR"].includes(user.role) && <Link href="/admin">Shop dashboard</Link>}</div>
        </div>
      </footer>

      {cartOpen && (
        <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCartOpen(false); }}>
          <aside className="cart-drawer" aria-label="Your request bag">
            <div className="drawer-header">
              <div><span className="drawer-kicker">YOUR LITTLE COLLECTION</span><h2>Request bag <span>({itemCount})</span></h2></div>
              <button className="close-button" onClick={() => setCartOpen(false)} aria-label="Close request bag"><X size={20} /></button>
            </div>
            {cart.length ? (
              <>
                <div className="cart-lines">
                  {cart.map((line) => {
                    const product = cartProducts.find((item) => item.id === line.productId);
                    if (!product) {
                      return <div className="cart-line" key={line.productId}><div className="cart-line-copy"><strong>This item is no longer available</strong><small>Remove it before submitting your request.</small></div><button className="remove-line" onClick={() => updateCart((items) => items.filter((item) => item.productId !== line.productId))} aria-label="Remove unavailable item"><X size={15} /></button></div>;
                    }
                    return (
                      <div className="cart-line" key={line.productId}>
                        <div className={`cart-thumbnail product-${categoryDesign[product.category]?.color.replace("category-", "") ?? "cream"}`} style={product.images[0] ? { backgroundImage: `url("${product.images[0].url}")` } : undefined} />
                        <div className="cart-line-copy"><span>{product.category}</span><strong>{product.name}</strong><small>{product.stockStatus === "OUT_OF_STOCK" ? "Currently unavailable" : product.priceMode === "QUOTE" ? "Quote requested after enquiry" : formatPrice(product.price)}</small>
                          <div className="quantity-control">
                            <button onClick={() => updateQuantity(product.id, -1)} aria-label={`Remove one ${product.name}`}><Minus size={13} /></button>
                            <span>{line.quantity}</span>
                            <button onClick={() => updateQuantity(product.id, 1)} disabled={line.quantity >= 50 || product.stockStatus === "OUT_OF_STOCK"} aria-label={`Add one ${product.name}`}><Plus size={13} /></button>
                          </div>
                        </div>
                        <button className="remove-line" onClick={() => updateCart((items) => items.filter((item) => item.productId !== product.id))} aria-label={`Remove ${product.name}`}><X size={15} /></button>
                      </div>
                    );
                  })}
                </div>
                <div className="drawer-summary">
                  <div><span>Known item total</span><strong>{formatPrice(cartTotal)}</strong></div>
                  {quoteCount > 0 && <p>We’ll confirm pricing for {quoteCount} quote item{quoteCount > 1 ? "s" : ""} before you decide.</p>}
                  <p className="no-payment-note"><ShieldCheck size={15} /> This is a request, not a payment.</p>
                  {cart.some((line) => { const product = cartProducts.find((item) => item.id === line.productId); return !product || product.stockStatus === "OUT_OF_STOCK"; }) && <p className="request-error">Remove unavailable items before sending your request.</p>}
                  <button className="button button-dark drawer-checkout" disabled={cart.some((line) => { const product = cartProducts.find((item) => item.id === line.productId); return !product || product.stockStatus === "OUT_OF_STOCK"; })} onClick={() => { setCartOpen(false); if (user) { setAddressesLoading(true); setCheckoutOpen(true); } else router.push("/login?returnTo=%2F"); }}>Continue to request <ArrowRight size={16} /></button>
                  <button className="keep-shopping" onClick={() => setCartOpen(false)}>Keep looking around</button>
                </div>
              </>
            ) : (
              <div className="empty-bag">
                <span className="empty-bag-icon"><ShoppingBag size={24} /></span>
                <h3>Your next favourite is out there.</h3>
                <p>Add something lovely and we’ll help you with the rest.</p>
                <button className="button button-dark" onClick={() => setCartOpen(false)}>Explore instruments <ArrowRight size={15} /></button>
              </div>
            )}
          </aside>
        </div>
      )}

      {checkoutOpen && (
        <div className="overlay modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCheckout(); }}>
          <section className="request-modal" role="dialog" aria-modal="true" aria-labelledby="request-title">
            <button className="close-button modal-close" onClick={closeCheckout} aria-label="Close request form"><X size={20} /></button>
            {submittedOrder ? (
              <div className="request-success">
                <span className="success-mark"><Check size={27} /></span>
                <div className="eyebrow"><span className="eyebrow-line" /> THAT’S A LOVELY CHOICE</div>
                <h2 id="request-title">Your request is <em>with us.</em></h2>
                <p>We’ll be in touch to confirm availability, final pricing and delivery. No payment has been taken.</p>
                <div className="order-reference"><span>YOUR REQUEST NUMBER</span><strong>{submittedOrder}</strong></div>
                <Link href="/account/orders" className="button button-dark" onClick={closeCheckout}>See my requests <ArrowRight size={16} /></Link>
                <button className="keep-shopping" onClick={closeCheckout}>Back to browsing</button>
              </div>
            ) : (
              <>
                <div className="eyebrow"><span className="eyebrow-line" /> ONE LAST LITTLE THING</div>
                <h2 id="request-title">Where should we <em>find you?</em></h2>
                <p className="request-intro">Send your request and a real person from our shop will get in touch to confirm the details.</p>
                <div className="request-summary">
                  {cart.map((line) => {
                    const product = cartProducts.find((item) => item.id === line.productId);
                    return product ? <div key={line.productId}><span>{line.quantity} × {product.name}</span><strong>{product.priceMode === "QUOTE" ? "Quote" : formatPrice(product.price * line.quantity)}</strong></div> : null;
                  })}
                  <div className="request-total"><span>Known item total</span><strong>{formatPrice(cartTotal)}{quoteCount > 0 ? " +" : ""}</strong></div>
                </div>
                <form className="request-form" onSubmit={submitRequest}>
                  {addressesLoading && <div className="app-loading" role="status">Checking your saved addresses…</div>}
                  <div className="checkout-account"><span>YOUR ACCOUNT</span><strong>{user?.name}</strong><span>{user?.email ?? user?.phone}</span><Link href="/account/profile">Update your contact details</Link></div>
                  {addresses.length > 0 && <label>Delivery address<select value={selectedAddressId} onChange={(event) => setSelectedAddressId(event.target.value)}><option value="">Enter a different address</option>{addresses.map((address) => <option value={address.id} key={address.id}>{address.recipientName} · {address.line1}, {address.city}{address.isDefault ? " · Default" : ""}</option>)}</select></label>}
                  {selectedAddressId && addresses.some((address) => address.id === selectedAddressId) ? (
                    <div className="checkout-address-preview"><strong>{addresses.find((address) => address.id === selectedAddressId)?.recipientName}</strong><span>{addresses.find((address) => address.id === selectedAddressId)?.line1}{addresses.find((address) => address.id === selectedAddressId)?.line2 ? `, ${addresses.find((address) => address.id === selectedAddressId)?.line2}` : ""}</span><span>{addresses.find((address) => address.id === selectedAddressId)?.city}, {addresses.find((address) => address.id === selectedAddressId)?.state} {addresses.find((address) => address.id === selectedAddressId)?.postalCode}</span><Link href="/account/profile">Manage saved addresses</Link></div>
                  ) : (
                    <>
                      <div className="form-row"><label>Recipient name<input name="recipientName" autoComplete="name" defaultValue={user?.name ?? ""} placeholder="Name at the delivery address" minLength={2} required /></label><label>Address phone<input name="deliveryPhone" type="tel" autoComplete="tel" defaultValue={user?.phone ?? ""} placeholder="+91 98765 43210" minLength={8} required /></label></div>
                      <label>Address line 1<input name="line1" autoComplete="street-address" placeholder="House / street / area" required /></label>
                      <label>Address line 2<input name="line2" placeholder="Apartment, landmark (optional)" /></label>
                      <div className="form-row"><label>City<input name="city" autoComplete="address-level2" placeholder="Your city" required /></label><label>State<input name="state" autoComplete="address-level1" placeholder="Your state" required /></label></div>
                      <label>PIN code<input name="postalCode" autoComplete="postal-code" inputMode="numeric" placeholder="000 000" required minLength={5} /></label>
                    </>
                  )}
                  <label>A note for the shop <span>(optional)</span><textarea name="buyerNotes" rows={2} maxLength={1000} placeholder="A size, finish or question you’d like us to know about" /></label>
                  <button type="submit" className="button button-dark submit-request" disabled={addressesLoading || !cart.length || cart.some((line) => !cartProducts.find((item) => item.id === line.productId) || cartProducts.find((item) => item.id === line.productId)?.stockStatus === "OUT_OF_STOCK")}>Send my request <ArrowRight size={16} /></button>
                  <p className="form-privacy"><ShieldCheck size={14} /> Just a request. No payment until we’ve spoken.</p>
                  {requestError && <p className="request-error" role="alert">{requestError}</p>}
                </form>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
