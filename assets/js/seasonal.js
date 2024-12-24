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

window.addEventListener('load', function() {
  $('#backgroundCarousel').carousel(getSeasonalImageIndex());
});
