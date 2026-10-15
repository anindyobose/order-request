import {
  NotificationStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PriceMode,
  Prisma,
  Role,
  StockStatus,
} from "@prisma/client";
import { GraphQLError, GraphQLScalarType, Kind } from "graphql";
import { randomUUID } from "node:crypto";
import { createSchema } from "graphql-yoga";
import type { IResolvers } from "@graphql-tools/utils";
import {
  AuthContext,
  requireRole,
  requireUser,
} from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  assertQuantity,
  assertTransition,
  assertValidPage,
  parsePositiveMoney,
  requireText,
  validationError,
} from "@/lib/domain";
import {
  enqueueBuyerDispatchSms,
  enqueueBuyerStatusNotice,
  enqueueConfiguredAdminNotices,
  orderItemsSummary,
  notificationSettings,
} from "@/lib/notifications";
import { enforceRateLimit } from "@/lib/rate-limit";

const typeDefs = /* GraphQL */ `
  scalar DateTime
  scalar JSON

  enum Role { BUYER ORDER_OPERATOR ADMIN }
  enum UserStatus { ACTIVE DISABLED }
  enum PriceMode { FIXED QUOTE }
  enum StockStatus { IN_STOCK LIMITED OUT_OF_STOCK }
  enum OrderStatus {
    REQUESTED REVIEWING AWAITING_BUYER_CONFIRMATION AWAITING_PAYMENT
    PAYMENT_VERIFIED READY_TO_DISPATCH DISPATCHED DELIVERED CANCELLED
  }
  enum PaymentStatus { NOT_DUE PENDING PARTIALLY_PAID VERIFIED REFUND_PENDING REFUNDED }
  enum PaymentMethod { CASH BANK_TRANSFER UPI CARD_OFFLINE OTHER }
  enum NotificationStatus { PENDING PROCESSING SENT RETRY FAILED }
  enum NotificationChannel { EMAIL SMS }

  type User { id: ID!, name: String!, email: String, phone: String, role: Role!, status: UserStatus! }
  type Address {
    id: ID!, recipientName: String!, phone: String!, line1: String!, line2: String
    city: String!, state: String!, postalCode: String!, isDefault: Boolean!
    createdAt: DateTime!, updatedAt: DateTime!
  }
  type ProductImage { id: ID!, url: String!, altText: String!, sortOrder: Int! }
  type Product {
    id: ID!, sku: String!, slug: String!, name: String!, description: String!
    category: String!, brand: String, price: Int!, mrp: Int, offerPrice: Int, priceMode: PriceMode!
    stockStatus: StockStatus!, active: Boolean!, archived: Boolean!, sortOrder: Int!
    images: [ProductImage!]!, createdAt: DateTime!, updatedAt: DateTime!
  }
  type ProductConnection { items: [Product!]!, total: Int!, page: Int!, pageSize: Int!, hasNextPage: Boolean! }
  type CatalogFacet { name: String!, count: Int! }
  type CatalogFacets { categories: [CatalogFacet!]!, brands: [CatalogFacet!]! }
  type AddressSnapshot {
    recipientName: String!, phone: String!, line1: String!, line2: String
    city: String!, state: String!, postalCode: String!
  }
  type OrderItem {
    id: ID!, sku: String!, name: String!, priceMode: PriceMode!
    requestedQuantity: Int!, quantity: Int!, requestedUnitPrice: Int
    agreedUnitPrice: Int, agreedVariant: String
  }
  type Shipment {
    courier: String!, trackingNumber: String, notes: String
    dispatchedAt: DateTime!, deliveredAt: DateTime
  }
  type PaymentRecord {
    id: ID!, amount: Int!, method: PaymentMethod!, reference: String
    verifiedAt: DateTime, createdAt: DateTime!
  }
  type OrderCustomer { id: ID!, name: String!, email: String, phone: String }
  type Order {
    id: ID!, orderNumber: String!, status: OrderStatus!, paymentStatus: PaymentStatus!
    subtotal: Int!, deliveryFee: Int!, discount: Int!, finalAmount: Int
    buyerNotes: String, termsMessage: String, cancellationReason: String
    createdAt: DateTime!, updatedAt: DateTime!
    termsConfirmedAt: DateTime, termsBuyerAcceptedAt: DateTime
    internalNotes: String
    customer: OrderCustomer!, address: AddressSnapshot!, items: [OrderItem!]!
    shipments: [Shipment!]!, paymentRecords: [PaymentRecord!]!
  }
  type OrderConnection { items: [Order!]!, total: Int!, page: Int!, pageSize: Int!, hasNextPage: Boolean! }
  type OrderEvent {
    id: ID!, action: String!, fromStatus: OrderStatus, toStatus: OrderStatus
    metadata: JSON, actorName: String, createdAt: DateTime!
  }
  type DashboardSummary {
    requested: Int!, reviewing: Int!, awaitingBuyerConfirmation: Int!
    awaitingPayment: Int!, paymentVerified: Int!, readyToDispatch: Int!
    dispatched: Int!, delivered: Int!, cancelled: Int!
  }
  type NotificationJob {
    id: ID!, orderNumber: String, eventType: String!, channel: NotificationChannel!
    recipient: String!, status: NotificationStatus!, attempts: Int!
    nextAttemptAt: DateTime!, sentAt: DateTime, lastError: String, createdAt: DateTime!
  }
  type NotificationSettings {
    adminRecipients: [String!]!, newOrderEmailEnabled: Boolean!
    buyerDispatchSmsEnabled: Boolean!
    emailConfigured: Boolean!, smsConfigured: Boolean!
  }

  input PageInput { page: Int, pageSize: Int }
  input ProductFilter {
    search: String, category: String, brand: String, minPrice: Int, maxPrice: Int
    priceMode: PriceMode, stockStatus: StockStatus, ids: [ID!]
  }
  input AddressInput {
    recipientName: String!, phone: String!, line1: String!, line2: String
    city: String!, state: String!, postalCode: String!
    isDefault: Boolean, addressId: ID
  }
  input AddressUpdateInput {
    recipientName: String!, phone: String!, line1: String!, line2: String
    city: String!, state: String!, postalCode: String!, isDefault: Boolean!
  }
  input OrderRequestItemInput { productId: ID!, quantity: Int! }
  input OrderRequestInput {
    items: [OrderRequestItemInput!]!, address: AddressInput!, buyerNotes: String
    idempotencyKey: String!
  }
  input ConfirmedItemInput {
    orderItemId: ID!, quantity: Int!, agreedUnitPrice: Int!, agreedVariant: String
  }
  input OrderTermsInput {
    orderNumber: String!, items: [ConfirmedItemInput!]!, deliveryFee: Int!
    discount: Int!, buyerMessage: String
  }
  input AdminOrderFilter {
    status: OrderStatus, fromDate: DateTime, toDate: DateTime, search: String
  }
  input ProductInput {
    id: ID, sku: String!, slug: String!, name: String!, description: String!
    category: String!, brand: String, price: Int!, mrp: Int, offerPrice: Int, priceMode: PriceMode!
    stockStatus: StockStatus!, active: Boolean!, sortOrder: Int!
  }
  input ProductImageInput { url: String!, altText: String!, sortOrder: Int! }
  input NotificationSettingsInput {
    adminRecipients: [String!]!, newOrderEmailEnabled: Boolean!
    buyerDispatchSmsEnabled: Boolean!
  }
  input DispatchInput {
    orderNumber: String!, courier: String!, trackingNumber: String, notes: String
  }

  type Query {
    me: User
    adminUsers(search: String): [User!]!
    products(filter: ProductFilter, page: PageInput): ProductConnection!
    catalogFacets: CatalogFacets!
    product(slug: String!): Product
    myAddresses: [Address!]!
    myOrders(page: PageInput): OrderConnection!
    myOrder(orderNumber: String!): Order
    adminOrders(filter: AdminOrderFilter, page: PageInput): OrderConnection!
    adminOrder(orderNumber: String!): Order
    orderEvents(orderNumber: String!): [OrderEvent!]!
    dashboardSummary: DashboardSummary!
    adminProducts(includeArchived: Boolean): [Product!]!
    notificationJobs(status: NotificationStatus, page: PageInput): [NotificationJob!]!
    notificationSettings: NotificationSettings!
  }
  type Mutation {
    updateMyProfile(name: String!, email: String, phone: String): User!
    setUserRole(userId: ID!, role: Role!): User!
    saveAddress(input: AddressInput!): Address!
    updateAddress(addressId: ID!, input: AddressUpdateInput!): Address!
    deleteAddress(addressId: ID!): Boolean!
    setDefaultAddress(addressId: ID!): Address!
    submitOrderRequest(input: OrderRequestInput!): Order!
    startOrderReview(orderNumber: String!): Order!
    addCallNotes(orderNumber: String!, notes: String!): Order!
    confirmOrderTerms(input: OrderTermsInput!): Order!
    acceptOrderTerms(orderNumber: String!): Order!
    recordPayment(orderNumber: String!, amount: Int!, method: PaymentMethod!, reference: String): PaymentRecord!
    verifyPayment(paymentRecordId: ID!): Order!
    markReadyToDispatch(orderNumber: String!): Order!
    dispatchOrder(input: DispatchInput!): Order!
    markDelivered(orderNumber: String!): Order!
    cancelOrder(orderNumber: String!, reason: String!): Order!
    markRefunded(orderNumber: String!, reference: String): Order!
    saveProduct(input: ProductInput!): Product!
    setProductImages(productId: ID!, images: [ProductImageInput!]!): Product!
    removeProductImage(imageId: ID!): Boolean!
    archiveProduct(productId: ID!): Product!
    updateNotificationSettings(input: NotificationSettingsInput!): NotificationSettings!
    retryNotification(notificationJobId: ID!): NotificationJob!
  }
`;

const dateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  serialize(value) {
    if (!(value instanceof Date) && typeof value !== "string") {
      throw validationError("DateTime values must be valid dates.");
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw validationError("DateTime values must be valid dates.");
    return date.toISOString();
  },
  parseValue(value) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw validationError("DateTime values must be valid ISO date strings.");
    }
    return new Date(value);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING || Number.isNaN(Date.parse(ast.value))) {
      throw validationError("DateTime values must be valid ISO date strings.");
    }
    return new Date(ast.value);
  },
});

const jsonScalar = new GraphQLScalarType({
  name: "JSON",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING) return ast.value;
    if (ast.kind === Kind.INT) return Number.parseInt(ast.value, 10);
    if (ast.kind === Kind.FLOAT) return Number.parseFloat(ast.value);
    if (ast.kind === Kind.BOOLEAN) return ast.value;
    if (ast.kind === Kind.OBJECT) {
      return Object.fromEntries(
        ast.fields.map((field) => [
          field.name.value,
          field.value.kind === Kind.STRING ? field.value.value : null,
        ]),
      );
    }
    return null;
  },
});

const staffRoles = [Role.ORDER_OPERATOR, Role.ADMIN];
const adminRoles = [Role.ADMIN];

function pageArgs(page?: number, pageSize?: number) {
  return assertValidPage(page, pageSize);
}

function productInclude() {
  return {
    images: {
      orderBy: { sortOrder: Prisma.SortOrder.asc },
      select: { id: true, url: true, altText: true, sortOrder: true },
    },
  } as const;
}

function orderInclude() {
  return {
    user: { select: { id: true, name: true, email: true, phone: true } },
    items: { orderBy: { id: Prisma.SortOrder.asc } },
    shipments: { orderBy: { dispatchedAt: Prisma.SortOrder.desc } },
    paymentRecords: { orderBy: { createdAt: Prisma.SortOrder.asc } },
  } as const;
}

function toOrderConnection(
  items: Awaited<ReturnType<typeof prisma.order.findMany>>,
  total: number,
  page: number,
  pageSize: number,
) {
  return { items, total, page, pageSize, hasNextPage: page * pageSize < total };
}

function addressInputToSnapshot(input: {
  recipientName: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
}) {
  const phone = requireText(input.phone, "Address phone", 20);
  if (!/^\+?[0-9 ()-]{8,20}$/.test(phone)) {
    throw validationError("Enter a valid delivery phone number.");
  }
  return {
    recipientName: requireText(input.recipientName, "Recipient name", 100),
    phone: phone.replace(/[ ()-]/g, ""),
    line1: requireText(input.line1, "Street address", 200),
    line2: input.line2?.trim().slice(0, 200) || null,
    city: requireText(input.city, "City", 100),
    state: requireText(input.state, "State", 100),
    postalCode: requireText(input.postalCode, "Postal code", 20),
  };
}

async function createOrderEvent(
  tx: Prisma.TransactionClient,
  orderId: string,
  actorId: string | null,
  action: string,
  fromStatus: OrderStatus | null,
  toStatus: OrderStatus | null,
  metadata?: Prisma.InputJsonObject,
) {
  const event = await tx.orderEvent.create({
    data: { orderId, actorId, action, fromStatus, toStatus, metadata },
  });
  if (toStatus !== null && fromStatus !== toStatus) {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        finalAmount: true,
        deliveryFee: true,
        user: { select: { email: true } },
      },
    });
    await enqueueBuyerStatusNotice(
      tx,
      event.id,
      order,
      fromStatus,
      toStatus,
      order.user.email,
    );
  }
}

async function orderTransaction<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2034" ||
        attempt >= 2
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

const resolvers: IResolvers<unknown, AuthContext> = {
  DateTime: dateTimeScalar,
  JSON: jsonScalar,
  Product: {
    mrp: (product: { mrp?: number | null; price: number; priceMode: PriceMode }) =>
      product.priceMode === PriceMode.FIXED
        ? product.mrp ?? (product.price > 0 ? product.price : null)
        : null,
    offerPrice: (product: { offerPrice?: number | null }) => product.offerPrice ?? null,
  },
  Query: {
    me: (_: unknown, __: unknown, ctx: AuthContext) => ctx.user,
    adminUsers: async (_: unknown, { search }: { search?: string }, ctx: AuthContext) => {
      requireRole(ctx.user, adminRoles);
      const normalizedSearch = search?.trim();
      if (normalizedSearch && normalizedSearch.length < 2) {
        throw validationError("Enter at least two characters to search for a user.");
      }
      if (normalizedSearch && normalizedSearch.length > 100) {
        throw validationError("User search must be at most 100 characters.");
      }
      return prisma.user.findMany({
        where: normalizedSearch
          ? {
              OR: [
                { name: { contains: normalizedSearch, mode: "insensitive" } },
                { email: { contains: normalizedSearch, mode: "insensitive" } },
                { phone: { contains: normalizedSearch, mode: "insensitive" } },
              ],
            }
          : {},
        select: { id: true, name: true, email: true, phone: true, role: true, status: true },
        orderBy: [{ role: "asc" }, { name: "asc" }],
        take: 50,
      });
    },
    products: async (
      _: unknown,
      args: {
        filter?: {
          search?: string;
          category?: string;
          brand?: string;
          minPrice?: number;
          maxPrice?: number;
          priceMode?: PriceMode;
          stockStatus?: StockStatus;
          ids?: string[];
        };
        page?: { page?: number; pageSize?: number };
      },
    ) => {
      const { page, pageSize } = pageArgs(args.page?.page, args.page?.pageSize);
      const filter = args.filter ?? {};
      const search = filter.search?.trim();
      if (search && search.length > 100) throw validationError("Search text must be at most 100 characters.");
      const where: Prisma.ProductWhereInput = {
        active: true,
        archived: false,
        ...(filter.ids ? { id: { in: filter.ids.slice(0, 100) } } : {}),
        ...(filter.category ? { category: { equals: requireText(filter.category, "Category", 100), mode: "insensitive" } } : {}),
        ...(filter.brand ? { brand: { contains: requireText(filter.brand, "Brand", 100), mode: "insensitive" } } : {}),
        ...(filter.priceMode ? { priceMode: filter.priceMode } : {}),
        ...(filter.stockStatus ? { stockStatus: filter.stockStatus } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { description: { contains: search, mode: "insensitive" } },
                { category: { contains: search, mode: "insensitive" } },
                { brand: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
        ...(filter.minPrice !== undefined || filter.maxPrice !== undefined
          ? {
              price: {
                ...(filter.minPrice !== undefined ? { gte: parsePositiveMoney(filter.minPrice, "Minimum price") } : {}),
                ...(filter.maxPrice !== undefined ? { lte: parsePositiveMoney(filter.maxPrice, "Maximum price") } : {}),
              },
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        prisma.product.findMany({
          where,
          include: productInclude(),
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.product.count({ where }),
      ]);
      return { items, total, page, pageSize, hasNextPage: page * pageSize < total };
    },
    catalogFacets: async () => {
      const where = { active: true, archived: false };
      const [categoryGroups, brandGroups] = await Promise.all([
        prisma.product.groupBy({
          by: ["category"],
          where,
          _count: { _all: true },
          orderBy: { category: "asc" },
        }),
        prisma.product.groupBy({
          by: ["brand"],
          where: { ...where, brand: { not: null } },
          _count: { _all: true },
          orderBy: { brand: "asc" },
        }),
      ]);
      return {
        categories: categoryGroups.map(({ category, _count }) => ({
          name: category,
          count: _count._all,
        })),
        brands: brandGroups.flatMap(({ brand, _count }) =>
          brand ? [{ name: brand, count: _count._all }] : [],
        ),
      };
    },
    product: (_: unknown, { slug }: { slug: string }) =>
      prisma.product.findFirst({
        where: { slug, active: true, archived: false },
        include: productInclude(),
      }),
    myAddresses: (_: unknown, __: unknown, ctx: AuthContext) => {
      const user = requireUser(ctx.user);
      return prisma.address.findMany({
        where: { userId: user.id },
        orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      });
    },
    myOrders: async (
      _: unknown,
      args: { page?: { page?: number; pageSize?: number } },
      ctx: AuthContext,
    ) => {
      const user = requireUser(ctx.user);
      const { page, pageSize } = pageArgs(args.page?.page, args.page?.pageSize);
      const where = { userId: user.id };
      const [items, total] = await Promise.all([
        prisma.order.findMany({
          where,
          include: orderInclude(),
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.order.count({ where }),
      ]);
      return toOrderConnection(items, total, page, pageSize);
    },
    myOrder: async (_: unknown, { orderNumber }: { orderNumber: string }, ctx: AuthContext) => {
      const user = requireUser(ctx.user);
      return prisma.order.findFirst({
        where: { orderNumber, userId: user.id },
        include: orderInclude(),
      });
    },
    adminOrders: async (
      _: unknown,
      args: {
        filter?: { status?: OrderStatus; fromDate?: Date; toDate?: Date; search?: string };
        page?: { page?: number; pageSize?: number };
      },
      ctx: AuthContext,
    ) => {
      requireRole(ctx.user, staffRoles);
      const { page, pageSize } = pageArgs(args.page?.page, args.page?.pageSize);
      const filter = args.filter ?? {};
      if (filter.fromDate && filter.toDate && filter.fromDate > filter.toDate) {
        throw validationError("The start date must be before the end date.");
      }
      const search = filter.search?.trim();
      if (search && search.length > 100) {
        throw validationError("Search text must be at most 100 characters.");
      }
      const where: Prisma.OrderWhereInput = {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.fromDate || filter.toDate
          ? {
              createdAt: {
                ...(filter.fromDate ? { gte: filter.fromDate } : {}),
                ...(filter.toDate ? { lte: filter.toDate } : {}),
              },
            }
          : {}),
        ...(search
          ? {
              OR: [
                { orderNumber: { contains: search, mode: "insensitive" } },
                { user: { name: { contains: search, mode: "insensitive" } } },
                { user: { email: { contains: search, mode: "insensitive" } } },
                { user: { phone: { contains: search, mode: "insensitive" } } },
                { addressSnapshot: { path: ["recipientName"], string_contains: search } },
                { addressSnapshot: { path: ["phone"], string_contains: search } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        prisma.order.findMany({
          where,
          include: orderInclude(),
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.order.count({ where }),
      ]);
      return toOrderConnection(items, total, page, pageSize);
    },
    adminOrder: (
      _: unknown,
      { orderNumber }: { orderNumber: string },
      ctx: AuthContext,
    ) => {
      requireRole(ctx.user, staffRoles);
      return prisma.order.findUnique({ where: { orderNumber }, include: orderInclude() });
    },
    orderEvents: async (
      _: unknown,
      { orderNumber }: { orderNumber: string },
      ctx: AuthContext,
    ) => {
      requireRole(ctx.user, staffRoles);
      const order = await prisma.order.findUnique({ where: { orderNumber }, select: { id: true } });
      if (!order) return [];
      return prisma.orderEvent.findMany({
        where: { orderId: order.id },
        include: { actor: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      });
    },
    dashboardSummary: async (_: unknown, __: unknown, ctx: AuthContext) => {
      requireRole(ctx.user, staffRoles);
      const groups = await prisma.order.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      const counts = Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
      return {
        requested: counts.REQUESTED ?? 0,
        reviewing: counts.REVIEWING ?? 0,
        awaitingBuyerConfirmation: counts.AWAITING_BUYER_CONFIRMATION ?? 0,
        awaitingPayment: counts.AWAITING_PAYMENT ?? 0,
        paymentVerified: counts.PAYMENT_VERIFIED ?? 0,
        readyToDispatch: counts.READY_TO_DISPATCH ?? 0,
        dispatched: counts.DISPATCHED ?? 0,
        delivered: counts.DELIVERED ?? 0,
        cancelled: counts.CANCELLED ?? 0,
      };
    },
    adminProducts: (
      _: unknown,
      args: { includeArchived?: boolean },
      ctx: AuthContext,
    ) => {
      requireRole(ctx.user, staffRoles);
      return prisma.product.findMany({
        where: args.includeArchived ? {} : { archived: false },
        include: productInclude(),
        orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
      });
    },
    notificationJobs: async (
      _: unknown,
      args: { status?: NotificationStatus; page?: { page?: number; pageSize?: number } },
      ctx: AuthContext,
    ) => {
      requireRole(ctx.user, adminRoles);
      const { page, pageSize } = pageArgs(args.page?.page, args.page?.pageSize);
      return prisma.notificationJob.findMany({
        where: args.status ? { status: args.status } : {},
        include: { order: { select: { orderNumber: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
    },
    notificationSettings: async (_: unknown, __: unknown, ctx: AuthContext) => {
      requireRole(ctx.user, adminRoles);
      return notificationSettings();
    },
  },
  Mutation: {
    setUserRole: async (
      _: unknown,
      { userId, role }: { userId: string; role: Role },
      ctx: AuthContext,
    ) => {
      const admin = requireRole(ctx.user, adminRoles);
      if (userId === admin.id) {
        throw validationError("You cannot change your own administrator role.");
      }
      if (role !== Role.ADMIN && role !== Role.ORDER_OPERATOR) {
        throw validationError("User access can only be granted or revoked between administrator and order operator.");
      }
      return prisma.$transaction(async (tx) => {
        const target = await tx.user.findUnique({ where: { id: userId } });
        if (!target) throw new GraphQLError("User not found.", { extensions: { code: "NOT_FOUND" } });
        if (target.role === Role.ADMIN && role !== Role.ADMIN) {
          const administratorCount = await tx.user.count({ where: { role: Role.ADMIN } });
          if (administratorCount <= 1) {
            throw validationError("The last administrator cannot be revoked. Grant another administrator role first.");
          }
        }
        return tx.user.update({ where: { id: userId }, data: { role } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },
    updateMyProfile: async (
      _: unknown,
      args: { name: string; email?: string | null; phone?: string | null },
      ctx: AuthContext,
    ) => {
      const user = requireUser(ctx.user);
      const email = args.email?.trim().toLowerCase() || null;
      const phone = args.phone?.trim().replace(/[ ()-]/g, "") || null;
      if (!email && !phone) throw validationError("Keep at least one email address or phone number on your account.");
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw validationError("Enter a valid email address.");
      if (phone && !/^\+?[0-9]{8,16}$/.test(phone)) throw validationError("Enter a valid phone number.");
      try {
        return await prisma.user.update({
          where: { id: user.id },
          data: {
            name: requireText(args.name, "Name", 100),
            email,
            phone,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new GraphQLError("That email address or phone number belongs to another account.", {
            extensions: { code: "DUPLICATE_ACCOUNT" },
          });
        }
        throw error;
      }
    },
    saveAddress: async (
      _: unknown,
      { input }: { input: {
        recipientName: string; phone: string; line1: string; line2?: string | null;
        city: string; state: string; postalCode: string; isDefault?: boolean; addressId?: string;
      } },
      ctx: AuthContext,
    ) => {
      const user = requireUser(ctx.user);
      const address = addressInputToSnapshot(input);
      return prisma.$transaction(async (tx) => {
        if (input.isDefault || !(await tx.address.count({ where: { userId: user.id } }))) {
          await tx.address.updateMany({ where: { userId: user.id }, data: { isDefault: false } });
        }
        const data = { ...address, isDefault: input.isDefault ?? false };
        if (input.addressId) {
          const existing = await tx.address.findFirst({
            where: { id: input.addressId, userId: user.id },
          });
          if (!existing) throw new GraphQLError("Address not found.", { extensions: { code: "NOT_FOUND" } });
          return tx.address.update({ where: { id: existing.id }, data });
        }
        return tx.address.create({ data: { ...data, userId: user.id } });
      });
    },
    updateAddress: async (
      _: unknown,
      { addressId, input }: {
        addressId: string;
        input: { recipientName: string; phone: string; line1: string; line2?: string | null; city: string; state: string; postalCode: string; isDefault: boolean };
      },
      ctx: AuthContext,
    ) => {
      const user = requireUser(ctx.user);
      const snapshot = addressInputToSnapshot(input);
      return prisma.$transaction(async (tx) => {
        const address = await tx.address.findFirst({ where: { id: addressId, userId: user.id } });
        if (!address) throw new GraphQLError("Address not found.", { extensions: { code: "NOT_FOUND" } });
        if (input.isDefault) await tx.address.updateMany({ where: { userId: user.id }, data: { isDefault: false } });
        return tx.address.update({ where: { id: addressId }, data: { ...snapshot, isDefault: input.isDefault } });
      });
    },
    deleteAddress: async (_: unknown, { addressId }: { addressId: string }, ctx: AuthContext) => {
      const user = requireUser(ctx.user);
      return prisma.$transaction(async (tx) => {
        const address = await tx.address.findFirst({ where: { id: addressId, userId: user.id } });
        if (!address) throw new GraphQLError("Address not found.", { extensions: { code: "NOT_FOUND" } });
        await tx.address.delete({ where: { id: addressId } });
        if (address.isDefault) {
          const replacement = await tx.address.findFirst({
            where: { userId: user.id },
            orderBy: { updatedAt: "desc" },
          });
          if (replacement) await tx.address.update({ where: { id: replacement.id }, data: { isDefault: true } });
        }
        return true;
      });
    },
    setDefaultAddress: async (_: unknown, { addressId }: { addressId: string }, ctx: AuthContext) => {
      const user = requireUser(ctx.user);
      return prisma.$transaction(async (tx) => {
        const address = await tx.address.findFirst({ where: { id: addressId, userId: user.id } });
        if (!address) throw new GraphQLError("Address not found.", { extensions: { code: "NOT_FOUND" } });
        await tx.address.updateMany({ where: { userId: user.id }, data: { isDefault: false } });
        return tx.address.update({ where: { id: addressId }, data: { isDefault: true } });
      });
    },
    submitOrderRequest: async (
      _: unknown,
      { input }: { input: {
        items: Array<{ productId: string; quantity: number }>;
        address: { recipientName: string; phone: string; line1: string; line2?: string | null; city: string; state: string; postalCode: string; addressId?: string };
        buyerNotes?: string | null;
        idempotencyKey: string;
      } },
      ctx: AuthContext,
    ) => {
      const user = requireUser(ctx.user);
      await enforceRateLimit(`order-request:${user.id}`, 10, 60 * 60 * 1000);
      if (!input.items.length || input.items.length > 50) throw validationError("Choose between 1 and 50 different products.");
      const idempotencyKey = requireText(input.idempotencyKey, "Request key", 100);
      const existing = await prisma.order.findUnique({
        where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
        include: orderInclude(),
      });
      if (existing) return existing;
      const uniqueProductIds = new Set(input.items.map((item) => item.productId));
      if (uniqueProductIds.size !== input.items.length) throw validationError("A product can only appear once in the request.");
      for (const item of input.items) assertQuantity(item.quantity);
      const products = await prisma.product.findMany({
        where: {
          id: { in: [...uniqueProductIds] },
          active: true,
          archived: false,
          stockStatus: { not: StockStatus.OUT_OF_STOCK },
        },
      });
      if (products.length !== input.items.length) {
        throw validationError("One or more items are no longer available. Refresh the catalog and try again.");
      }
      const address = addressInputToSnapshot(input.address);
      const subtotal = input.items.reduce((sum, item) => {
        const product = products.find((candidate) => candidate.id === item.productId);
        return sum + (product?.priceMode === PriceMode.FIXED ? product.price * item.quantity : 0);
      }, 0);
      const orderNumber = `NCM-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
      try {
        return await prisma.$transaction(async (tx) => {
          const savedAddress = input.address.addressId
            ? await tx.address.findFirst({
                where: { id: input.address.addressId, userId: user.id },
              })
            : null;
          if (input.address.addressId && !savedAddress) {
            throw new GraphQLError("The selected delivery address was not found.", {
              extensions: { code: "NOT_FOUND" },
            });
          }
          const order = await tx.order.create({
            data: {
              orderNumber,
              idempotencyKey,
              userId: user.id,
              subtotal,
              buyerNotes: input.buyerNotes?.trim().slice(0, 1000) || null,
              addressSnapshot: savedAddress
                ? addressInputToSnapshot(savedAddress)
                : address,
              items: {
                create: input.items.map((item) => {
                  const product = products.find((candidate) => candidate.id === item.productId)!;
                  return {
                    productId: product.id,
                    skuSnapshot: product.sku,
                    productNameSnapshot: product.name,
                    priceMode: product.priceMode,
                    requestedQuantity: item.quantity,
                    quantity: item.quantity,
                    requestedUnitPrice: product.priceMode === PriceMode.FIXED ? product.price : null,
                  };
                }),
              },
            },
            include: orderInclude(),
          });
          await createOrderEvent(tx, order.id, user.id, "REQUEST_SUBMITTED", null, OrderStatus.REQUESTED, {
            itemCount: input.items.reduce((sum, item) => sum + item.quantity, 0),
            buyerNote: input.buyerNotes?.trim().slice(0, 1000) || null,
          });
          await enqueueConfiguredAdminNotices(tx, order, "ORDER_REQUESTED", {
            orderNumber,
            customerName: user.name,
            customerEmail: user.email ?? "",
            customerPhone: user.phone ?? "",
            items: orderItemsSummary(order.items),
          });
          return order;
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const retryOrder = await prisma.order.findUnique({
            where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
            include: orderInclude(),
          });
          if (retryOrder) return retryOrder;
        }
        throw error;
      }
    },
    startOrderReview: async (
      _: unknown,
      { orderNumber }: { orderNumber: string },
      ctx: AuthContext,
    ) => {
      const staff = requireRole(ctx.user, staffRoles);
      return orderTransaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { orderNumber } });
        if (!order) throw new GraphQLError("Request not found.", { extensions: { code: "NOT_FOUND" } });
        assertTransition(order.status, OrderStatus.REVIEWING);
        const updated = await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.REVIEWING },
          include: orderInclude(),
        });
        await createOrderEvent(tx, order.id, staff.id, "REVIEW_STARTED", order.status, updated.status);
        return updated;
      });
    },
    addCallNotes: async (
      _: unknown,
      { orderNumber, notes }: { orderNumber: string; notes: string },
      ctx: AuthContext,
    ) => {
      const staff = requireRole(ctx.user, staffRoles);
      const cleanNotes = notes.trim();
      if (cleanNotes.length > 5000) throw validationError("Call notes must be no longer than 5,000 characters.");
      return orderTransaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { orderNumber } });
        if (!order) throw new GraphQLError("Request not found.", { extensions: { code: "NOT_FOUND" } });
        await tx.order.update({ where: { id: order.id }, data: { internalNotes: cleanNotes } });
        await createOrderEvent(
          tx,
          order.id,
          staff.id,
          "CALL_NOTES_UPDATED",
          order.status,
          order.status,
          { notes: cleanNotes },
        );
        return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude() });
      });
    },
    confirmOrderTerms: async (
      _: unknown,
      { input }: { input: {
        orderNumber: string;
        items: Array<{ orderItemId: string; quantity: number; agreedUnitPrice: number; agreedVariant?: string | null }>;
        deliveryFee: number;
        discount: number;
        buyerMessage?: string | null;
      } },
      ctx: AuthContext,
    ) => {
      const staff = requireRole(ctx.user, staffRoles);
      const deliveryFee = parsePositiveMoney(input.deliveryFee, "Delivery fee");
      const discount = parsePositiveMoney(input.discount, "Discount");
      if (!input.items.length || input.items.length > 50) throw validationError("Confirm the terms for all requested items.");
      return orderTransaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { orderNumber: input.orderNumber },
          include: { items: true, user: true },
        });
        if (!order) throw new GraphQLError("Request not found.", { extensions: { code: "NOT_FOUND" } });
        if (
          order.status !== OrderStatus.REVIEWING &&
          order.status !== OrderStatus.AWAITING_BUYER_CONFIRMATION
        ) {
          throw new GraphQLError("Order terms can only be updated before payment is due.", {
            extensions: { code: "INVALID_STATE_TRANSITION" },
          });
        }
        if (order.status === OrderStatus.REVIEWING) {
          assertTransition(order.status, OrderStatus.AWAITING_BUYER_CONFIRMATION);
        }
        if (new Set(input.items.map((item) => item.orderItemId)).size !== order.items.length ||
            input.items.length !== order.items.length ||
            order.items.some((item) => !input.items.some((confirmed) => confirmed.orderItemId === item.id))) {
          throw validationError("Include the approved quantity and final unit price for every item.");
        }
        let subtotal = 0;
        for (const item of input.items) {
          assertQuantity(item.quantity);
          parsePositiveMoney(item.agreedUnitPrice, "Agreed unit price");
          const original = order.items.find((orderItem) => orderItem.id === item.orderItemId)!;
          if (item.quantity > original.requestedQuantity) {
            throw validationError("An approved quantity cannot exceed the quantity the buyer requested.");
          }
          subtotal += item.quantity * item.agreedUnitPrice;
          await tx.orderItem.update({
            where: { id: original.id },
            data: {
              quantity: item.quantity,
              agreedUnitPrice: item.agreedUnitPrice,
              agreedVariant: item.agreedVariant?.trim().slice(0, 200) || null,
            },
          });
        }
        const finalAmount = subtotal + deliveryFee - discount;
        if (finalAmount <= 0) {
          throw validationError("Final terms must leave a positive amount due after delivery and discounts.");
        }
        const fromStatus = order.status;
        const updated = await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.AWAITING_BUYER_CONFIRMATION,
            subtotal,
            deliveryFee,
            discount,
            finalAmount,
            termsConfirmedAt: new Date(),
            termsBuyerAcceptedAt: null,
            termsMessage: input.buyerMessage?.trim().slice(0, 1000) || null,
          },
          include: orderInclude(),
        });
        await createOrderEvent(
          tx,
          order.id,
          staff.id,
          "FINAL_TERMS_RECORDED",
          fromStatus,
          OrderStatus.AWAITING_BUYER_CONFIRMATION,
          {
            finalAmount,
            deliveryFee,
            discount,
            buyerMessage: input.buyerMessage?.trim().slice(0, 1000) || null,
          },
        );
        return updated;
      });
    },
    acceptOrderTerms: async (
      _: unknown,
      { orderNumber }: { orderNumber: string },
      ctx: AuthContext,
    ) => {
      const user = requireUser(ctx.user);
      return orderTransaction(async (tx) => {
        const order = await tx.order.findFirst({
          where: { orderNumber, userId: user.id },
        });
        if (!order) throw new GraphQLError("Request not found.", { extensions: { code: "NOT_FOUND" } });
        if (order.finalAmount === null || order.termsConfirmedAt === null) {
          throw validationError("The shop has not confirmed final terms yet.");
        }
        if (
          order.status !== OrderStatus.AWAITING_BUYER_CONFIRMATION &&
          order.status !== OrderStatus.AWAITING_PAYMENT
        ) {
          throw new GraphQLError("These order terms can no longer be accepted.", {
            extensions: { code: "INVALID_STATE_TRANSITION" },
          });
        }
        if (order.termsBuyerAcceptedAt) {
          throw validationError("You have already accepted these final terms.");
        }
        if (order.status === OrderStatus.AWAITING_BUYER_CONFIRMATION) {
          assertTransition(order.status, OrderStatus.AWAITING_PAYMENT);
        }
        const updated = await tx.order.update({
          where: { id: order.id },
          data: {
            ...(order.status === OrderStatus.AWAITING_BUYER_CONFIRMATION
              ? { status: OrderStatus.AWAITING_PAYMENT, paymentStatus: PaymentStatus.PENDING }
              : {}),
            termsBuyerAcceptedAt: new Date(),
          },
          include: orderInclude(),
        });
        await createOrderEvent(tx, order.id, user.id, "TERMS_ACCEPTED_BY_BUYER", order.status, updated.status);
        return updated;
      });
    },
    recordPayment: async (
      _: unknown,
      args: { orderNumber: string; amount: number; method: PaymentMethod; reference?: string | null },
      ctx: AuthContext,
    ) => {
      const staff = requireRole(ctx.user, staffRoles);
      const amount = parsePositiveMoney(args.amount, "Payment amount", false);
      return orderTransaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { orderNumber: args.orderNumber } });
        if (
          !order ||
          (order.status !== OrderStatus.AWAITING_PAYMENT &&
            order.status !== OrderStatus.AWAITING_BUYER_CONFIRMATION) ||
          order.finalAmount === null
        ) {
          throw new GraphQLError("Payment details can only be recorded after final terms are confirmed.", {
            extensions: { code: "INVALID_STATE_TRANSITION" },
          });
        }
        const recordedTotal = await tx.paymentRecord.aggregate({
          where: { orderId: order.id },
          _sum: { amount: true },
        });
        const balance = order.finalAmount - (recordedTotal._sum.amount ?? 0);
        if (amount > balance) throw validationError("The payment amount cannot exceed the remaining balance.");
        if (order.status === OrderStatus.AWAITING_BUYER_CONFIRMATION) {
          assertTransition(order.status, OrderStatus.AWAITING_PAYMENT);
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.AWAITING_PAYMENT, paymentStatus: PaymentStatus.PENDING },
          });
        }
        const payment = await tx.paymentRecord.create({
          data: {
            orderId: order.id,
            amount,
            method: args.method,
            reference: args.reference?.trim().slice(0, 200) || null,
            recordedById: staff.id,
          },
        });
        if (order.status === OrderStatus.AWAITING_BUYER_CONFIRMATION) {
          await createOrderEvent(
            tx,
            order.id,
            staff.id,
            "PAYMENT_DETAILS_RECORDED_BY_STAFF",
            OrderStatus.AWAITING_BUYER_CONFIRMATION,
            OrderStatus.AWAITING_PAYMENT,
            { paymentRecordId: payment.id, amount, method: args.method },
          );
        }
        return payment;
      });
    },
    verifyPayment: async (
      _: unknown,
      { paymentRecordId }: { paymentRecordId: string },
      ctx: AuthContext,
    ) => {
      const staff = requireRole(ctx.user, staffRoles);
      return orderTransaction(async (tx) => {
        const payment = await tx.paymentRecord.findUnique({
          where: { id: paymentRecordId },
          include: { order: true },
        });
        if (!payment) throw new GraphQLError("Payment record not found.", { extensions: { code: "NOT_FOUND" } });
        if (payment.verifiedAt) throw validationError("This payment has already been verified.");
        const order = payment.order;
        if (order.status !== OrderStatus.AWAITING_PAYMENT || order.finalAmount === null) {
          throw new GraphQLError("Payment can only be verified for an order awaiting payment.", {
            extensions: { code: "INVALID_STATE_TRANSITION" },
          });
        }
        await tx.paymentRecord.update({
          where: { id: payment.id },
          data: { verifiedAt: new Date(), verifiedById: staff.id },
        });
        const verifiedTotal = await tx.paymentRecord.aggregate({
          where: { orderId: order.id, verifiedAt: { not: null } },
          _sum: { amount: true },
        });
        const paid = verifiedTotal._sum.amount ?? 0;
        const fullyPaid = paid >= order.finalAmount;
        const updated = await tx.order.update({
          where: { id: order.id },
          data: {
            ...(fullyPaid
              ? { status: OrderStatus.PAYMENT_VERIFIED, paymentStatus: PaymentStatus.VERIFIED }
              : { paymentStatus: PaymentStatus.PARTIALLY_PAID }),
          },
          include: { ...orderInclude(), user: true },
        });
        await createOrderEvent(
          tx,
          order.id,
          staff.id,
          fullyPaid ? "PAYMENT_VERIFIED" : "PARTIAL_PAYMENT_VERIFIED",
          order.status,
          updated.status,
          { paymentRecordId, verifiedAmount: payment.amount, verifiedTotal: paid },
        );
        return updated;
      });
    },
    markReadyToDispatch: async (
      _: unknown,
      { orderNumber }: { orderNumber: string },
      ctx: AuthContext,
    ) => {
      const staff = requireRole(ctx.user, staffRoles);
      return orderTransaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { orderNumber } });
        if (!order) throw new GraphQLError("Request not found.", { extensions: { code: "NOT_FOUND" } });
        assertTransition(order.status, OrderStatus.READY_TO_DISPATCH);
        if (order.paymentStatus !== PaymentStatus.VERIFIED) {
          throw validationError("Verify the full payment before preparing this order for dispatch.");
        }
        const updated = await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.READY_TO_DISPATCH },
          include: orderInclude(),
        });
        await createOrderEvent(tx, order.id, staff.id, "READY_TO_DISPATCH", order.status, updated.status);
        return updated;
      });
    },
    dispatchOrder: async (
      _: unknown,
      { input }: { input: { orderNumber: string; courier: string; trackingNumber?: string | null; notes?: string | null } },
      ctx: AuthContext,
    ) => {
      const staff = requireRole(ctx.user, staffRoles);
      const courier = requireText(input.courier, "Courier", 100);
      return orderTransaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { orderNumber: input.orderNumber },
          include: { user: true },
        });
        if (!order) throw new GraphQLError("Request not found.", { extensions: { code: "NOT_FOUND" } });
        assertTransition(order.status, OrderStatus.DISPATCHED);
        if (order.paymentStatus !== PaymentStatus.VERIFIED) {
          throw validationError("Verify the full payment before dispatching this order.");
        }
        const now = new Date();
        await tx.shipment.create({
          data: {
            orderId: order.id,
            courier,
            trackingNumber: input.trackingNumber?.trim().slice(0, 200) || null,
            notes: input.notes?.trim().slice(0, 1000) || null,
            dispatchedAt: now,
          },
        });
        const updated = await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.DISPATCHED },
          include: orderInclude(),
        });
        await createOrderEvent(tx, order.id, staff.id, "ORDER_DISPATCHED", order.status, updated.status, {
          courier,
          hasTracking: Boolean(input.trackingNumber?.trim()),
          dispatchNote: input.notes?.trim().slice(0, 1000) || null,
        });
        await enqueueBuyerDispatchSms(
          tx,
          updated,
          order.user.phone,
          {
            orderNumber: order.orderNumber,
            courier,
            trackingNumber: input.trackingNumber?.trim() ?? "",
          },
        );
        return updated;
      });
    },
    markDelivered: async (
      _: unknown,
      { orderNumber }: { orderNumber: string },
      ctx: AuthContext,
    ) => {
      const staff = requireRole(ctx.user, staffRoles);
      return orderTransaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { orderNumber },
          include: { shipments: { orderBy: { dispatchedAt: "desc" }, take: 1 } },
        });
        if (!order) throw new GraphQLError("Request not found.", { extensions: { code: "NOT_FOUND" } });
        assertTransition(order.status, OrderStatus.DELIVERED);
        const now = new Date();
        if (order.shipments[0]) {
          await tx.shipment.update({ where: { id: order.shipments[0].id }, data: { deliveredAt: now } });
        }
        const updated = await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.DELIVERED },
          include: orderInclude(),
        });
        await createOrderEvent(tx, order.id, staff.id, "ORDER_DELIVERED", order.status, updated.status);
        return updated;
      });
    },
    cancelOrder: async (
      _: unknown,
      { orderNumber, reason }: { orderNumber: string; reason: string },
      ctx: AuthContext,
    ) => {
      const staff = requireRole(ctx.user, staffRoles);
      const cancellationReason = requireText(reason, "Cancellation reason", 500);
      return orderTransaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { orderNumber },
          include: { user: { select: { email: true, phone: true } } },
        });
        if (!order) throw new GraphQLError("Request not found.", { extensions: { code: "NOT_FOUND" } });
        assertTransition(order.status, OrderStatus.CANCELLED);
        const paymentTotal = await tx.paymentRecord.aggregate({
          where: { orderId: order.id },
          _sum: { amount: true },
        });
        const refundFollowUp =
          (paymentTotal._sum.amount ?? 0) > 0 ||
          order.paymentStatus === PaymentStatus.PARTIALLY_PAID ||
          order.paymentStatus === PaymentStatus.VERIFIED ||
          order.paymentStatus === PaymentStatus.REFUND_PENDING;
        const updated = await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.CANCELLED,
            cancellationReason,
            paymentStatus: refundFollowUp
              ? PaymentStatus.REFUND_PENDING
              : PaymentStatus.NOT_DUE,
          },
          include: orderInclude(),
        });
        await createOrderEvent(tx, order.id, staff.id, "ORDER_CANCELLED", order.status, updated.status, {
          reason: cancellationReason,
          refundFollowUp: refundFollowUp ? "Refund follow-up required." : null,
        });
        return updated;
      });
    },
    markRefunded: async (
      _: unknown,
      { orderNumber, reference }: { orderNumber: string; reference?: string | null },
      ctx: AuthContext,
    ) => {
      const staff = requireRole(ctx.user, staffRoles);
      const refundReference = reference?.trim().slice(0, 200) || null;
      return orderTransaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { orderNumber } });
        if (!order) throw new GraphQLError("Request not found.", { extensions: { code: "NOT_FOUND" } });
        if (order.status !== OrderStatus.CANCELLED || order.paymentStatus !== PaymentStatus.REFUND_PENDING) {
          throw new GraphQLError("Only cancelled orders with a pending refund can be marked refunded.", {
            extensions: { code: "INVALID_STATE_TRANSITION" },
          });
        }
        const updated = await tx.order.update({
          where: { id: order.id },
          data: { paymentStatus: PaymentStatus.REFUNDED },
          include: orderInclude(),
        });
        await createOrderEvent(
          tx,
          order.id,
          staff.id,
          "REFUND_RECORDED",
          order.status,
          order.status,
          { reference: refundReference },
        );
        return updated;
      });
    },
    saveProduct: async (
      _: unknown,
      { input }: { input: {
        id?: string | null; sku: string; slug: string; name: string; description: string;
        category: string; brand?: string | null; price: number; mrp?: number | null;
        offerPrice?: number | null; priceMode: PriceMode;
        stockStatus: StockStatus; active: boolean; sortOrder: number;
      } },
      ctx: AuthContext,
    ) => {
      requireRole(ctx.user, adminRoles);
      const mrp = input.priceMode === PriceMode.FIXED
        ? parsePositiveMoney(input.mrp ?? input.price, "MRP", false)
        : null;
      const offerPrice = input.priceMode === PriceMode.FIXED && input.offerPrice != null
        ? parsePositiveMoney(input.offerPrice, "Offer price", false)
        : null;
      if (mrp !== null && offerPrice !== null && offerPrice >= mrp) {
        throw validationError("Offer price must be lower than MRP.");
      }
      const data = {
        sku: requireText(input.sku, "SKU", 80),
        slug: requireText(input.slug, "Slug", 120).toLowerCase(),
        name: requireText(input.name, "Product name", 160),
        description: requireText(input.description, "Description", 5000),
        category: requireText(input.category, "Category", 100),
        brand: input.brand?.trim().slice(0, 100) || null,
        price: input.priceMode === PriceMode.FIXED ? offerPrice ?? mrp! : 0,
        mrp,
        offerPrice,
        priceMode: input.priceMode,
        stockStatus: input.stockStatus,
        active: input.active,
        sortOrder: Number.isInteger(input.sortOrder) ? input.sortOrder : 0,
      };
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.slug)) {
        throw validationError("Use a lowercase URL slug with letters, numbers and hyphens.");
      }
      try {
        return input.id
          ? await prisma.product.update({
              where: { id: input.id },
              data: { ...data, archived: false },
              include: productInclude(),
            })
          : await prisma.product.create({ data, include: productInclude() });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new GraphQLError("That product SKU or slug is already in use.", {
            extensions: { code: "DUPLICATE_PRODUCT" },
          });
        }
        throw error;
      }
    },
    setProductImages: async (
      _: unknown,
      { productId, images }: { productId: string; images: Array<{ url: string; altText: string; sortOrder: number }> },
      ctx: AuthContext,
    ) => {
      requireRole(ctx.user, adminRoles);
      if (images.length > 12) throw validationError("A product can have at most 12 images.");
      for (const image of images) {
        if (!image.url.startsWith("/uploads/")) throw validationError("Product images must use the shop upload endpoint.");
        requireText(image.altText, "Image description", 200);
        if (!Number.isInteger(image.sortOrder) || image.sortOrder < 0) throw validationError("Image order must be a positive whole number.");
      }
      return prisma.$transaction(async (tx) => {
        const product = await tx.product.findUnique({
          where: { id: productId },
          select: {
            id: true,
            images: { select: { url: true, data: true } },
          },
        });
        if (!product) {
          throw new GraphQLError("Product not found.", { extensions: { code: "NOT_FOUND" } });
        }
        const uploadedData = new Map(
          product.images.map((image) => [image.url, image.data]),
        );
        await tx.productImage.deleteMany({ where: { productId } });
        await tx.productImage.createMany({
          data: images.map((image) => ({
            productId,
            url: image.url,
            altText: requireText(image.altText, "Image description", 200),
            sortOrder: image.sortOrder,
            data: uploadedData.get(image.url) ?? undefined,
          })),
        });
        return tx.product.findUniqueOrThrow({
          where: { id: productId },
          include: productInclude(),
        });
      });
    },
    removeProductImage: async (_: unknown, { imageId }: { imageId: string }, ctx: AuthContext) => {
      requireRole(ctx.user, adminRoles);
      const image = await prisma.productImage.findUnique({
        where: { id: imageId },
        select: { id: true, url: true },
      });
      if (!image) return false;
      await prisma.productImage.delete({ where: { id: image.id } });
      return true;
    },
    archiveProduct: async (_: unknown, { productId }: { productId: string }, ctx: AuthContext) => {
      requireRole(ctx.user, adminRoles);
      return prisma.product.update({
        where: { id: productId },
        data: { active: false, archived: true },
        include: productInclude(),
      });
    },
    updateNotificationSettings: async (
      _: unknown,
      { input }: { input: {
        adminRecipients: string[];
        newOrderEmailEnabled: boolean;
        buyerDispatchSmsEnabled: boolean;
      } },
      ctx: AuthContext,
    ) => {
      requireRole(ctx.user, adminRoles);
      const recipients = [...new Set(input.adminRecipients.map((email) => email.trim().toLowerCase()).filter(Boolean))];
      if (recipients.length > 20 || recipients.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        throw validationError("Enter up to 20 valid administrator email addresses.");
      }
      return prisma.notificationSettings.upsert({
        where: { id: "global" },
        create: { ...input, adminRecipients: recipients },
        update: { ...input, adminRecipients: recipients },
      });
    },
    retryNotification: async (
      _: unknown,
      { notificationJobId }: { notificationJobId: string },
      ctx: AuthContext,
    ) => {
      const admin = requireRole(ctx.user, adminRoles);
      return prisma.$transaction(async (tx) => {
        const job = await tx.notificationJob.findUnique({
          where: { id: notificationJobId },
          include: { order: { select: { id: true, status: true } } },
        });
        if (!job) throw new GraphQLError("Notification job not found.", { extensions: { code: "NOT_FOUND" } });
        if (job.status !== NotificationStatus.FAILED) {
          throw validationError("Only permanently failed notifications can be retried.");
        }
        const retried = await tx.notificationJob.update({
          where: { id: notificationJobId },
          data: {
            status: NotificationStatus.RETRY,
            attempts: 0,
            nextAttemptAt: new Date(),
            claimedAt: null,
            lastError: null,
          },
          include: { order: { select: { orderNumber: true } } },
        });
        if (job.order) {
          await createOrderEvent(
            tx,
            job.order.id,
            admin.id,
            "NOTIFICATION_RETRY_REQUESTED",
            job.order.status,
            job.order.status,
            { notificationJobId, channel: job.channel, eventType: job.eventType },
          );
        }
        return retried;
      });
    },
  },
  Order: {
    internalNotes: (order: { internalNotes?: string | null }, _: unknown, ctx: AuthContext) => {
      requireRole(ctx.user, staffRoles);
      return order.internalNotes ?? null;
    },
    customer: (order: { user: unknown }) => order.user,
    address: (order: { addressSnapshot: unknown }) => order.addressSnapshot,
    items: (order: { items: unknown }) => order.items,
    shipments: (order: { shipments: unknown }) => order.shipments,
    paymentRecords: (
      order: { paymentRecords: unknown },
      _: unknown,
      ctx: AuthContext,
    ) => {
      requireRole(ctx.user, staffRoles);
      return order.paymentRecords;
    },
  },
  OrderItem: {
    name: (item: { productNameSnapshot?: string; name?: string }) =>
      item.productNameSnapshot ?? item.name,
    sku: (item: { skuSnapshot?: string; sku?: string }) =>
      item.skuSnapshot ?? item.sku,
  },
  PaymentRecord: {
    reference: (payment: { reference: string | null }, _: unknown, ctx: AuthContext) => {
      requireRole(ctx.user, staffRoles);
      return payment.reference;
    },
  },
  OrderEvent: {
    actorName: (event: { actor?: { name: string } | null }) => event.actor?.name ?? "System",
  },
  NotificationJob: {
    orderNumber: (job: { order?: { orderNumber: string } | null }) => job.order?.orderNumber ?? null,
  },
  NotificationSettings: {
    emailConfigured: () => Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM),
    smsConfigured: () => Boolean(process.env.SMS_PROVIDER_URL && process.env.SMS_PROVIDER_TOKEN),
  },
};

export const schema = createSchema<AuthContext>({
  typeDefs,
  resolvers,
});
