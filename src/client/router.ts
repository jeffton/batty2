import { createRouter, createWebHistory } from "vue-router";
import { appBaseUrl } from "@/client/lib/base-url";
import ChatView from "@/client/views/ChatView.vue";
import LoginView from "@/client/views/LoginView.vue";
export const router = createRouter({
  history: createWebHistory(appBaseUrl()),
  routes: [
    { path: "/", name: "home", component: ChatView },
    { path: "/login", name: "login", component: LoginView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
