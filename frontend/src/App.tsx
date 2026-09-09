import React from "react";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { Toaster } from "@/components/ui/sonner";
import { RequestFeedback } from "@/components/RequestFeedback";

export const App: React.FC = () => {
  return (
    <>
      <RequestFeedback />
      <Toaster />
      <RouterProvider router={router} />
    </>
  );
};
