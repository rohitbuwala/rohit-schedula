import Razorpay from 'razorpay';
import { loadEnv } from '../config/env.js';

export const RAZORPAY_TOKEN = Symbol('RAZORPAY_TOKEN');

export interface RazorpayRefundResponse {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  payment_id: string;
  status: 'processed' | 'pending' | 'failed';
  receipt?: string;
  acquirer_data?: { arn?: string };
  notes?: Record<string, string>;
}

export interface RazorpayInstance {
  orders: {
    create(params: {
      amount: number;
      currency: string;
      receipt: string;
      notes?: Record<string, string>;
    }): Promise<{ id: string; amount: number | string; currency: string; status: string; receipt: string }>;
  };
  payments: {
    fetch(paymentId: string): Promise<{
      id: string;
      order_id: string;
      amount: number | string;
      currency: string;
      status: string;
    }>;
    refund(
      paymentId: string,
      params?: {
        amount?: number;
        notes?: Record<string, string>;
        receipt?: string;
        speed?: 'normal' | 'optimum';
      },
    ): Promise<RazorpayRefundResponse>;
  };
  refunds: {
    fetch(refundId: string): Promise<RazorpayRefundResponse>;
  };
}

export const razorpayProvider = {
  provide: RAZORPAY_TOKEN,
  useFactory: (): RazorpayInstance => {
    const env = loadEnv();
    return new Razorpay({
      key_id: env.razorpayKeyId,
      key_secret: env.razorpayKeySecret,
    }) as unknown as RazorpayInstance;
  },
};
