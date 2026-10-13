import { ResetPasswordForm } from "@/components/auth-form";
import { Suspense } from "react";

type ResetPasswordPageProps = { searchParams: Promise<{ token?: string }> };

async function ResetPasswordFormPage({ searchParams }: ResetPasswordPageProps) {
  const params = await searchParams;
  return <ResetPasswordForm token={params.token ?? ""} />;
}

export default function ResetPasswordPage(props: ResetPasswordPageProps) {
  return <Suspense fallback={<main className="auth-page"><div className="app-loading">Loading recovery form…</div></main>}><ResetPasswordFormPage {...props} /></Suspense>;
}
