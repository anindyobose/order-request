import { AuthForm } from "@/components/auth-form";
import { Suspense } from "react";

type RegisterPageProps = { searchParams: Promise<{ returnTo?: string }> };

async function RegisterFormPage({ searchParams }: RegisterPageProps) {
  const params = await searchParams;
  return <AuthForm mode="register" returnTo={params.returnTo ?? null} />;
}

export default function RegisterPage(props: RegisterPageProps) {
  return <Suspense fallback={<main className="auth-page"><div className="app-loading">Loading account form…</div></main>}><RegisterFormPage {...props} /></Suspense>;
}
