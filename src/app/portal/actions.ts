"use server";

import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma/client";
import { getSignedDownloadUrl } from "@/lib/supabase/storage";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function submitIntake(orderId: string, formData: FormData) {
  const user = await requireAuth();

  // Verify ownership
  const order = await prisma.orders.findFirst({
    where: { id: orderId, user_id: user.id },
  });

  if (!order) {
    return { error: "Pedido no encontrado o no autorizado" };
  }

  if (order.status !== "intake_pending") {
    return { error: "Este pedido ya tiene sus datos completados u orientados" };
  }

  // Validar campos del formulario antes de castear
  const titular = formData.get("titular");
  const actividad = formData.get("actividad");
  const detalles = formData.get("detalles");

  if (!titular || !actividad || !detalles) {
    return { error: "Faltan campos obligatorios del formulario" };
  }

  // Parse generic intake data fields into JSON
  const intakeData = {
    titular: titular.toString().trim(),
    actividad: actividad.toString().trim(),
    detalles: detalles.toString().trim(),
    submittedAt: new Date().toISOString(),
  };

  try {
    await prisma.orders.update({
      where: { id: orderId },
      data: {
        intake_data: intakeData,
        status: "processing",
        intake_completed_at: new Date(),
      },
    });

    // Also log this in audit_log
    await prisma.audit_log.create({
      data: {
        event: "intake_submitted",
        order_id: orderId,
        user_id: user.id,
        metadata: { status_change: "intake_pending -> processing" },
      },
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "portal.intake.save_error",
        message: err instanceof Error ? err.message : "Unknown",
        order_id: orderId,
        ts: new Date().toISOString(),
      }),
    );
    return { error: "Ocurrió un error al guardar los datos" };
  }

  revalidatePath(`/portal/pedido/${orderId}`, "page");
  redirect(`/portal/pedido/${orderId}`);
}

/**
 * Generates a signed 1-hour download URL for a final signed PDF.
 * Verifies ownership of the document before generating the URL.
 * Logs the download event to audit_log.
 */
export async function getSignedDocumentUrl(
  documentId: string,
): Promise<{ url?: string; error?: string }> {
  const user = await requireAuth();

  const doc = await prisma.documents.findFirst({
    where: { id: documentId },
    include: { order: true },
  });

  if (!doc || doc.order.user_id !== user.id) {
    return { error: "Documento no encontrado o no autorizado" };
  }

  if (doc.status !== "final" || !doc.signed_pdf_path) {
    return { error: "El documento firmado aún no está disponible" };
  }

  try {
    const url = await getSignedDownloadUrl(
      "documents",
      doc.signed_pdf_path,
      3600,
    );

    // Audit log — track document downloads
    await prisma.audit_log.create({
      data: {
        event: "document.downloaded",
        order_id: doc.order_id,
        user_id: user.id,
        metadata: {
          document_id: documentId,
          signed_pdf_path: doc.signed_pdf_path,
        },
      },
    });

    return { url };
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "portal.document.download_error",
        message: err instanceof Error ? err.message : "Unknown",
        document_id: documentId,
        ts: new Date().toISOString(),
      }),
    );
    return { error: "No se pudo generar el enlace de descarga" };
  }
}
