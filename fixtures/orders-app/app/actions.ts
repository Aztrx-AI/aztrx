"use server";

import { revalidatePath } from "next/cache";
import { applyAction } from "@/lib/orders";
import type { OrderAction } from "@/lib/workflow";

export async function orderAction(formData: FormData) {
  await applyAction(formData.get("action") as OrderAction);
  revalidatePath("/");
}
