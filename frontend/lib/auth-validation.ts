import { z } from "zod";

const phoneRegex = /^\+?[0-9]{7,15}$/;

export const loginSchema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

export const signupSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(100),
  email: z.email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters.").max(128),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match.",
});

export const patientSignupSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(100),
  email: z.email("Enter a valid email address."),
  phone: z
    .string()
    .trim()
    .regex(phoneRegex, "Enter a valid phone number (7–15 digits).")
    .optional()
    .or(z.literal("")),
  password: z.string().min(8, "Password must be at least 8 characters.").max(128),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match.",
});

export const doctorRegistrationSchema = z.object({
  name: z.string().trim().min(2, "Full name must be at least 2 characters.").max(100),
  email: z.email("Enter a valid email address."),
  phone: z.string().trim().regex(phoneRegex, "Enter a valid contact phone number (7–15 digits)."),
  password: z.string().min(8, "Password must be at least 8 characters.").max(128),
  confirmPassword: z.string(),
  specialty: z.string().trim().min(2, "Please enter your medical specialty.").max(100),
  licenseRegion: z.string().trim().min(2, "Enter your licensing state or council (e.g. NMC, Maharashtra).").max(80),
  licenseNumber: z.string().trim().min(3, "Enter your medical registration or license number.").max(80),
  qualifications: z.string().trim().min(2, "Enter your medical degrees or qualifications (e.g. MBBS, MD).").max(500),
  yearsOfExperience: z.coerce.number().int("Experience must be a whole number.").min(0, "Years of experience cannot be negative.").max(70, "Maximum experience is 70 years."),
  consultationFeeInr: z.coerce.number().int().min(0, "Consultation fee cannot be negative.").optional().default(500),
  clinicName: z.string().trim().max(200).optional().or(z.literal("")),
  clinicAddress: z.string().trim().max(500).optional().or(z.literal("")),
  bio: z.string().trim().max(1000).optional().or(z.literal("")),
}).refine((data) => data.password === data.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match.",
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SignupInput = z.infer<typeof signupSchema>;
export type PatientSignupInput = z.infer<typeof patientSignupSchema>;
export type DoctorRegistrationInput = z.infer<typeof doctorRegistrationSchema>;
