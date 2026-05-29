import { useEffect } from "react";
import { signInWithRedirect } from "aws-amplify/auth";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { AuthService } from "@/functions/authService";
import logoImage from "@/assets/KBA-logo.png";
import Footer from "@/components/Footer";

export default function LandingPage() {
  const navigate = useNavigate();

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const session = await AuthService.getAuthSession(true);
        if (session?.tokens?.accessToken) {
          navigate("/", { replace: true });
        }
      } catch {
        // not authenticated, stay on landing
      }
    };
    checkAuth();
  }, [navigate]);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <img src={logoImage} alt="KBA Logo" className="h-20 w-auto mx-auto mb-6" />
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Specialization Explorer
          </h1>
          <p className="text-gray-500 mb-8">
            Sign in with your UBC Microsoft account to continue.
          </p>
          <Button
            size="lg"
            className="w-full"
            onClick={() => signInWithRedirect({ provider: { custom: "EntraID" } })}
          >
            Sign in with Microsoft
          </Button>
        </div>
      </div>
      <Footer />
    </div>
  );
}
