import { ForgeAuth } from "@/components/ForgeAuth";

export const metadata = { title: "Sign up — Crucible" };

export default function SignUpPage() {
  return <ForgeAuth mode="sign-up" />;
}
