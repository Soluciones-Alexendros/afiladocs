"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { revalidateProductsCache } from "@/lib/catalog/query";
import { prisma } from "@/lib/prisma/client";

const CATEGORIES = [
  "rgpd",
  "arrendamiento",
  "civil",
  "mercantil",
  "pack",
  "reclamacion",
  "review",
] as const;
const KINDS = ["template", "review", "pack"] as const;
const DELIVERY_MODES = [
  "docuseal_fill_and_sign",
  "docuseal_fill_only",
  "download_after_payment",
  "human_review",
] as const;
const EIDAS_LEVELS = ["SES", "AES"] as const;
const VAT_MODES = ["included", "excluded"] as const;

const productSchema = z.object({
  sku: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[A-Z0-9-]+$/, "SKU debe ser MAYÚSCULAS, números y guiones"),
  slug: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9-]+$/, "slug en kebab-case"),
  title: z.string().min(3).max(200),
  description_md: z.string().min(1).max(10_000),
  category: z.enum(CATEGORIES),
  kind: z.enum(KINDS),
  price_cents: z.coerce.number().int().nonnegative().max(10_000_00),
  vat_mode: z.enum(VAT_MODES),
  stripe_price_id: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((v) => v || null),
  docuseal_template_id: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((v) => v || null),
  storage_path: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || null),
  delivery_mode: z.enum(DELIVERY_MODES),
  eidas_level: z.enum(EIDAS_LEVELS),
  is_active: z.coerce.boolean(),
  display_order: z.coerce.number().int().min(0).max(9999),
});

export type ProductFormState = {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

function parseForm(formData: FormData) {
  const raw = Object.fromEntries(formData.entries());
  return {
    ...raw,
    is_active:
      formData.get("is_active") === "on" ||
      formData.get("is_active") === "true",
  };
}

export async function createProduct(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  await requireRole(["admin", "ops"]);
  const parsed = productSchema.safeParse(parseForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      message: "Errores de validación",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;
  const exists = await prisma.products.findUnique({ where: { sku: data.sku } });
  if (exists) return { ok: false, message: `SKU ${data.sku} ya existe` };
  await prisma.products.create({ data });
  revalidatePath("/ops/productos");
  revalidateProductsCache();
  redirect(`/ops/productos/${data.sku}`);
}

export async function updateProduct(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  await requireRole(["admin", "ops"]);
  const sku = formData.get("sku")?.toString();
  if (!sku) return { ok: false, message: "SKU requerido" };
  const parsed = productSchema.safeParse(parseForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      message: "Errores de validación",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const patch = { ...parsed.data } as Partial<z.infer<typeof productSchema>>;
  delete patch.sku;
  await prisma.products.update({
    where: { sku },
    data: { ...patch, updated_at: new Date() },
  });
  revalidatePath("/ops/productos");
  revalidatePath(`/ops/productos/${sku}`);
  revalidateProductsCache();
  return { ok: true, message: "Producto actualizado" };
}
