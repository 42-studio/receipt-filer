import { useLocation, useNavigate, type Location } from "react-router";

type ModalState = { background?: Location } | null;

/** The page under an open receipt dialog. A deep link (an email) has none: the dashboard shows under it. */
export function useBackground(): Location | undefined {
  return (useLocation().state as ModalState)?.background;
}

/** Opens receipt dialogs over the current page and closes them back to it. */
export function useReceiptNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const background = (location.state as ModalState)?.background;
  const under = background ?? location;
  return {
    /** Link props: a real href (deep link, new tab) that opens as a dialog over this page. */
    link: (id: string, match = false) => ({ to: `/receipts/${id}${match ? "/match" : ""}`, state: { background: under } }),
    open: (id: string, match = false) => navigate(`/receipts/${id}${match ? "/match" : ""}`, { state: { background: under } }),
    /** One step back: match returns to details, details to the page under it. */
    close: () => (background ? navigate(-1) : navigate("/", { replace: true })),
    /** Closes every receipt dialog, back to the page under them. */
    closeAll: () => {
      const page = background && !background.pathname.startsWith("/receipts/") ? background : null;
      navigate(page ? { pathname: page.pathname, search: page.search } : "/", { replace: true });
    },
  };
}
