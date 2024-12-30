function getSeasonalImageIndex() {
  const month = new Date().getMonth();
  const seasons = {
    winter: [11, 0, 1],
    spring: [2, 3, 4],
    summer: [5, 6, 7],
    fall: [8, 9, 10]
  };
  
  for (const [season, months] of Object.entries(seasons)) {
    if (months.includes(month)) {
      return season === 'winter' ? 2 : 
             season === 'spring' ? 0 :
             season === 'fall' ? 1 : 0;
    }
  }
  return 0;
}

// Preload next image
function preloadNextImage(index) {
  const items = document.querySelectorAll('.carousel-item img');
  const nextIndex = (index + 1) % items.length;
  const nextImage = new Image();
  nextImage.src = items[nextIndex].src;
}

window.addEventListener('load', function() {
  const seasonalIndex = getSeasonalImageIndex();
  $('#backgroundCarousel').carousel(seasonalIndex);
  preloadNextImage(seasonalIndex);
});

document.addEventListener('DOMContentLoaded', function() {
  const textElement = document.querySelector('.text-preload');
  if (textElement) {
    requestAnimationFrame(() => {
      textElement.classList.add('text-loaded');
    });
  }
});
