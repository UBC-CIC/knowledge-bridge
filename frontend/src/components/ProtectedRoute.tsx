import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router";
import { AuthService } from "@/functions/authService";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
}

export default function ProtectedRoute({ children, requireAdmin = false }: ProtectedRouteProps) {
  const [status, setStatus] = useState<"loading" | "allowed" | "unauthenticated" | "forbidden">("loading");
  const location = useLocation();

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const session = await AuthService.getAuthSession(true);
        if (!session?.tokens?.accessToken) {
          setStatus("unauthenticated");
          return;
        }

        if (requireAdmin) {
          const groups = (session.tokens.idToken?.payload?.["cognito:groups"] as string[]) ?? [];
          if (!groups.includes("admin")) {
            setStatus("forbidden");
            return;
          }
        }

        setStatus("allowed");
      } catch {
        setStatus("unauthenticated");
      }
    };

    checkAuth();
  }, [requireAdmin]);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-600">Loading...</div>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (status === "forbidden") {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
