import { ForgeAuth } from "@/components/ForgeAuth";

export const metadata = { title: "Sign in — Crucible" };

export default function SignInPage() {
  return <ForgeAuth mode="sign-in" />;
}
