"use server";

import React from "react";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma/client";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { sendEmail } from "@/lib/email/send";
import { publicEnv } from "@/lib/env";
import { DocumentReadyEmail } from "@/emails/document-ready";
import { revalidatePath, revalidateTag } from "next/cache";

const VALID_ORDER_STATUSES = [
  "intake_pending",
  "processing",
  "draft_ready",
  "completed",
] as const;
type OrderStatus = (typeof VALID_ORDER_STATUSES)[number];

function buildDocumentFields(type: "draft" | "signed", storagePath: string) {
  const isDraft = type === "draft";
  return {
    status: isDraft ? "draft" : "final",
    draft_pdf_path: isDraft ? storagePath : null,
    signed_pdf_path: isDraft ? null : storagePath,
    uploadStatus: isDraft ? "draft_ready" : "completed",
  } as const;
}

async function notifyDraftReady(orderId: string) {
  const order = await prisma.orders.findUnique({ where: { id: orderId } });
  if (!order) return;

  const adminClient = createServiceRoleClient();
  const { data: authUser } = await adminClient.auth.admin.getUserById(
    order.user_id,
  );
  const customerEmail = authUser?.user?.email;
  if (!customerEmail) return;

  const profile = await prisma.profiles.findUnique({
    where: { id: order.user_id },
    select: { full_name: true },
  });

  await sendEmail({
    to: customerEmail,
    subject: "Tu borrador está listo para revisar — Afiladocs",
    react: React.createElement(DocumentReadyEmail, {
      userName: profile?.full_name ?? "Cliente",
      productName: order.product_id,
      version: "1",
      documentUrl: `${publicEnv.siteUrl}/portal/pedido/${orderId}`,
    }),
  });
}

export async function opsUpdateOrderStatus(
  orderId: string,
  formData: FormData,
) {
  const { user } = await requireRole(["admin", "ops"]);
  const rawStatus = formData.get("status");

  if (!rawStatus) return { error: "Estado no proporcionado" };

  const newStatus = rawStatus.toString();
  if (!(VALID_ORDER_STATUSES as readonly string[]).includes(newStatus)) {
    return { error: "Estado no válido" };
  }

  const validatedStatus = newStatus as OrderStatus;

  try {
    const updated = await prisma.orders.update({
      where: { id: orderId },
      data: { status: validatedStatus },
      select: { user_id: true },
    });

    await prisma.audit_log.create({
      data: {
        event: "order_status_updated_manually",
        order_id: orderId,
        user_id: user.id,
        metadata: { new_status: validatedStatus },
      },
    });

    revalidatePath(`/ops/pedido/${orderId}`, "page");
    revalidatePath(`/ops/pedidos`, "page");
    revalidateTag("orders", "default");
    revalidateTag(`orders-${updated.user_id}`, "default");
    revalidateTag(`order-${orderId}`, "default");

    if (validatedStatus === "draft_ready") {
      notifyDraftReady(orderId).catch((emailErr) => {
        console.error(
          JSON.stringify({
            event: "email.draft_ready.failed",
            orderId,
            message:
              emailErr instanceof Error ? emailErr.message : "Unknown error",
            ts: new Date().toISOString(),
          }),
        );
      });
    }

    return { success: true };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ops.order.update_error",
        message: error instanceof Error ? error.message : "Unknown",
        orderId,
        ts: new Date().toISOString(),
      }),
    );
    return { error: "Error al actualizar el pedido" };
  }
}

export async function opsUploadDocument(
  orderId: string,
  type: "draft" | "signed",
  formData: FormData,
) {
  const { user } = await requireRole(["admin", "ops"]);
  const file = formData.get("file") as File;

  if (!file || file.size === 0) {
    return { error: "No se subió ningún archivo" };
  }

  const order = await prisma.orders.findUnique({ where: { id: orderId } });
  if (!order) return { error: "Pedido no encontrado" };

  const supabase = await createClient();

  const fileName = `${type}_${Date.now()}.pdf`;
  const filePath = `${order.user_id}/${order.id}/${fileName}`;

  const { data, error } = await supabase.storage
    .from("documents")
    .upload(filePath, file, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (error) {
    console.error(
      JSON.stringify({
        event: "storage.upload.error",
        message: error.message,
        ts: new Date().toISOString(),
      }),
    );
    return { error: "Error al subir el archivo a Storage" };
  }

  try {
    const { status, draft_pdf_path, signed_pdf_path, uploadStatus } =
      buildDocumentFields(type, data.path);

    const documentRecord = await prisma.documents.create({
      data: {
        order_id: orderId,
        product_id: order.product_id,
        eidas_level: order.eidas_level,
        status,
        draft_pdf_path,
        signed_pdf_path,
      },
    });

    await prisma.orders.update({
      where: { id: orderId },
      data: { status: uploadStatus },
    });

    await prisma.audit_log.create({
      data: {
        event: `document_${type}_uploaded`,
        order_id: orderId,
        user_id: user.id,
        metadata: { document_id: documentRecord.id, path: data.path },
      },
    });

    revalidatePath(`/ops/pedido/${orderId}`, "page");
    revalidateTag("orders", "default");
    revalidateTag(`orders-${order.user_id}`, "default");
    revalidateTag(`order-${orderId}`, "default");
    return { success: true };
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "db.update.error_after_upload",
        message: err instanceof Error ? err.message : "Unknown",
        ts: new Date().toISOString(),
      }),
    );
    return { error: "Archivo subido pero error al actualizar base de datos" };
  }
}
