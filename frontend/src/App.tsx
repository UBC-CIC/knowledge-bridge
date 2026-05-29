import { BrowserRouter, Routes, Route } from "react-router";
import AppLayout from "./layouts/AppLayout";
import AIChatPage from "./pages/ChatInterface/ChatInterface";
import { UserProvider } from "./providers/UserContext";
import HomePage from "./pages/HomePage";
import AdminLogin from "./pages/Admin/AdminLogin";
import AdminDashboard from "./pages/Admin/AdminDashboard";
import ProtectedRoute from "./components/ProtectedRoute";
import { Amplify } from "aws-amplify";
import { Hub } from "aws-amplify/utils";

Amplify.configure({
  API: {
    REST: {
      MyApi: {
        endpoint: import.meta.env.VITE_API_ENDPOINT,
      },
    },
  },
  Auth: {
    Cognito: {
      userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID,
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
      loginWith: {
        oauth: {
          domain: "cic-kba.auth.ca-central-1.amazoncognito.com",
          scopes: ["openid", "email", "profile"],
          redirectSignIn: [
            import.meta.env.VITE_APP_URL || "http://localhost:5173",
          ],
          redirectSignOut: [
            import.meta.env.VITE_APP_URL || "http://localhost:5173",
          ],
          responseType: "code",
        },
      },
    },
  },
});

// Listen for OAuth redirect completion and reload session
Hub.listen("auth", ({ payload }) => {
  if (payload.event === "signInWithRedirect") {
    window.location.href = "/";
  }
});

function App() {
  return (
    <BrowserRouter>
      <UserProvider>
        <Routes>
          <Route element={<AppLayout />}>
            {/* Single login for all users */}
            <Route path="/login" element={<AdminLogin />} />

            {/* Chat — any authenticated user */}
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <HomePage />
                </ProtectedRoute>
              }
            >
              <Route path="chat" element={<AIChatPage />} />
            </Route>

            {/* Admin dashboard — admin group only */}
            <Route path="/admin/login" element={<AdminLogin />} />
            <Route
              path="/admin/dashboard"
              element={
                <ProtectedRoute requireAdmin>
                  <AdminDashboard />
                </ProtectedRoute>
              }
            />
          </Route>
        </Routes>
      </UserProvider>
    </BrowserRouter>
  );
}

export default App;
