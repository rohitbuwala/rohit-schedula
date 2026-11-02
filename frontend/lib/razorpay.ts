import type { RazorpayOptions, RazorpayResponse } from "@/types/razorpay";

export function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve(false);
      return;
    }

    if (window.Razorpay) {
      resolve(true);
      return;
    }

    const existingScript = document.querySelector('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(true));
      existingScript.addEventListener("error", () => resolve(false));
      return;
    }

    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export interface LaunchCheckoutParams {
  keyId: string;
  orderId: string;
  amountPaise: number;
  currency?: string;
  name?: string;
  description?: string;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  onDismiss?: () => void;
  onError?: (err: unknown) => void;
}

export async function launchRazorpayCheckout(
  params: LaunchCheckoutParams
): Promise<RazorpayResponse> {
  const isLoaded = await loadRazorpayScript();
  const RazorpayConstructor = typeof window !== "undefined" ? window.Razorpay : undefined;
  if (!isLoaded || !RazorpayConstructor) {
    throw new Error("Unable to load Razorpay payment gateway. Please check your internet connection.");
  }

  return new Promise<RazorpayResponse>((resolve, reject) => {
    let resolved = false;

    const options: RazorpayOptions = {
      key: params.keyId,
      amount: params.amountPaise,
      currency: params.currency || "INR",
      name: params.name || "Medrella Healthcare",
      description: params.description || "Consultation Fee",
      order_id: params.orderId,
      prefill: params.prefill,
      theme: {
        color: "#0d9488", // Teal brand accent
      },
      handler: (response: RazorpayResponse) => {
        resolved = true;
        resolve(response);
      },
      modal: {
        ondismiss: () => {
          if (!resolved) {
            params.onDismiss?.();
            reject(new Error("PAYMENT_DISMISSED"));
          }
        },
      },
    };

    try {
      const rzp = new RazorpayConstructor(options);
      rzp.on("payment.failed", (response: unknown) => {
        params.onError?.(response);
      });
      rzp.open();
    } catch (err) {
      reject(err);
    }
  });
}
