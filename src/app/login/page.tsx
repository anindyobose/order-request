import { AuthForm } from "@/components/auth-form";
import { Suspense } from "react";

type LoginPageProps = { searchParams: Promise<{ returnTo?: string }> };

async function LoginFormPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  return <AuthForm mode="login" returnTo={params.returnTo ?? null} />;
}

export default function LoginPage(props: LoginPageProps) {
  return <Suspense fallback={<main className="auth-page"><div className="app-loading">Loading sign in…</div></main>}><LoginFormPage {...props} /></Suspense>;
}
