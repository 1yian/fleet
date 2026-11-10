case $action in
  attach) roots=$*; backend_attach $(descendants "$@") || exit 1 ;;
  join)
    backend_exists
    case $? in
      0) roots=$*; backend_attach $(descendants "$@") || exit 1 ;;
      1) ;;
      *) echo "could not tell whether $unit exists" >&2; exit 1 ;;
    esac ;;
  kill) reap ;;
esac
